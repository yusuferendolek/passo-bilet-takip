// Passo bilet takipçisi: listedeki etkinliklerde bilet açıldıysa bildirim gönderir.
// cron-job.org gibi bir zamanlayıcı bu endpoint'i birkaç dakikada bir çağırır.

const API = "https://ticketingweb.passo.com.tr/api/passoweb/geteventdetails";
const LANG_TR = 118;

const DEFAULT_EVENTS =
  "https://www.passo.com.tr/tr/etkinlik/fjord-iksv-filmekimi-citys7-film-biletleri/13138330";

export function parseEventUrl(url) {
  const m = url.match(/etkinlik\/([^/?#]+)\/(\d+)/);
  if (!m) throw new Error(`Geçersiz Passo linki: ${url}`);
  return { url, slug: m[1], id: m[2] };
}

export async function checkEvent(event) {
  const res = await fetch(`${API}/${event.slug}/${event.id}/${LANG_TR}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
      Accept: "application/json",
      Origin: "https://www.passo.com.tr",
      Referer: "https://www.passo.com.tr/",
    },
  });
  const text = await res.text();
  let value;
  try {
    value = JSON.parse(text).value;
  } catch {
    throw new Error(`Passo JSON dönmedi (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
  if (!value) throw new Error(`Etkinlik bulunamadı (HTTP ${res.status})`);
  // Passo alanı kaldırır/yeniden adlandırırsa sessizce "bilet yok" demek yerine hata ver
  if (typeof value.isAvailable !== "boolean") throw new Error("Passo yanıtında isAvailable alanı yok");
  return {
    ...event,
    name: value.name,
    date: value.date,
    venue: value.venueName,
    available: value.isAvailable,
  };
}

export async function notify(title, message, clickUrl) {
  const jobs = [];

  if (process.env.NTFY_TOPIC) {
    jobs.push(
      fetch("https://ntfy.sh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: process.env.NTFY_TOPIC,
          title,
          message,
          priority: 5,
          tags: ["tickets"],
          click: clickUrl,
        }),
      })
    );
  }

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `${title}\n${message}\n${clickUrl}`,
        }),
      })
    );
  }

  // CallMeBot: kişisel kullanım için ücretsiz WhatsApp API'si (https://www.callmebot.com)
  if (process.env.WHATSAPP_PHONE && process.env.CALLMEBOT_APIKEY) {
    const params = new URLSearchParams({
      phone: process.env.WHATSAPP_PHONE,
      apikey: process.env.CALLMEBOT_APIKEY,
      text: `*${title}*\n${message}\n${clickUrl}`,
    });
    jobs.push(
      fetch(`https://api.callmebot.com/whatsapp.php?${params}`).then(async (r) => {
        // CallMeBot hataları (ör. geçersiz API key) 203 ile döndürür; fetch bunu "ok" sayar
        const text = await r.text();
        const ok = r.status === 200 && !/invalid|error/i.test(text);
        return new Response(text, { status: ok ? 200 : 502 });
      })
    );
  }

  if (jobs.length === 0) {
    throw new Error("Bildirim kanalı yok: NTFY_TOPIC, TELEGRAM_* veya WHATSAPP_PHONE + CALLMEBOT_APIKEY ayarla");
  }
  for (const r of await Promise.all(jobs)) {
    if (!r.ok) throw new Error(`Bildirim gönderilemedi (HTTP ${r.status}): ${(await r.text()).slice(0, 120)}`);
  }
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.query.key !== secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    if (req.query.test) {
      await notify("Test bildirimi", "Passo bilet takipçisi çalışıyor.", "https://www.passo.com.tr");
      return res.json({ test: "sent" });
    }

    const events = (process.env.EVENT_URLS || DEFAULT_EVENTS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseEventUrl);

    // Bir etkinliğin hatası (ör. geçmiş gösterim arşive taşındı) diğerlerinin bildirimini engellemesin
    const settled = await Promise.allSettled(events.map(checkEvent));
    const results = settled.map((s, i) =>
      s.status === "fulfilled" ? s.value : { ...events[i], error: String(s.reason?.message || s.reason) }
    );

    const errors = results.filter((r) => r.error).map((r) => r.error);

    for (const r of results.filter((r) => r.available)) {
      // Passo saatleri zaten Türkiye saati, saat dilimi dönüşümü yapmadan göster
      const [d, t] = r.date.split("T");
      const when = `${d.split("-").reverse().join(".")} ${t.slice(0, 5)}`;
      // Bir bildirimin hatası sonraki etkinliklerin bildirimini engellemesin
      try {
        await notify(`🎟️ Bilet açıldı: ${r.name}`, `${r.venue} · ${when}`, r.url);
      } catch (err) {
        errors.push(`${r.name} bildirimi: ${err.message || err}`);
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res
      .status(errors.length ? 502 : 200)
      .json({ checkedAt: new Date().toISOString(), results, ...(errors.length && { error: errors.join("; ") }) });
  } catch (err) {
    // 5xx dönünce cron-job.org hatayı görür ve (ayarlıysa) e-posta atar
    return res.status(502).json({ error: String(err.message || err) });
  }
}
