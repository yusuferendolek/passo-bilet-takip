// Passo bilet takipçisi: listedeki etkinliklerde bilet açıldıysa bildirim gönderir.
// cron-job.org gibi bir zamanlayıcı bu endpoint'i birkaç dakikada bir çağırır.

const API = "https://ticketingweb.passo.com.tr/api/passoweb/geteventdetails";
const LANG_TR = 118;

const DEFAULT_EVENTS =
  "https://www.passo.com.tr/tr/etkinlik/fjord-iksv-filmekimi-citys7-film-biletleri/13138330";

// Passo tarihleri saat dilimi içermeyen Türkiye saati; Türkiye 2016'dan beri sabit UTC+3
export function hasPassed(passoDate, now = new Date()) {
  return new Date(`${passoDate}+03:00`) <= now;
}

// Girdi: "<passo linki>" ya da "<passo linki>|<son tarih, ör. 2026-10-09T16:00>"
export function parseEventUrl(entry) {
  const [url, deadline] = entry.split("|").map((s) => s.trim());
  const m = url.match(/etkinlik\/([^/?#]+)\/(\d+)/);
  if (!m) throw new Error(`Geçersiz Passo linki: ${url}`);
  if (deadline && Number.isNaN(new Date(`${deadline}+03:00`).getTime())) {
    throw new Error(`Geçersiz son tarih: ${deadline}`);
  }
  return { url, slug: m[1], id: m[2], ...(deadline && { deadline }) };
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

export async function notify(title, message, clickUrl, actions) {
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
          ...(actions && { actions }),
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

// cron-job.org API'siyle zamanlayıcı işini kapatır; bilet alındıktan sonra bildirimler kesilir
export async function stopCron() {
  const { CRONJOB_API_KEY, CRONJOB_JOB_ID } = process.env;
  if (!CRONJOB_API_KEY || !CRONJOB_JOB_ID) throw new Error("CRONJOB_API_KEY ve CRONJOB_JOB_ID ayarlı değil");
  const res = await fetch(`https://api.cron-job.org/jobs/${CRONJOB_JOB_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${CRONJOB_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ job: { enabled: false } }),
  });
  if (!res.ok) throw new Error(`cron-job.org işi durdurulamadı (HTTP ${res.status}): ${(await res.text()).slice(0, 120)}`);
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

    if (req.query.stop) {
      // Link önizlemeleri gibi kazara GET istekleri takibi kapatmasın
      if (req.method !== "POST") return res.status(405).json({ error: "stop için POST gerekli" });
      await stopCron();
      // Takip durdu; onay bildirimi gidemese bile isteği başarılı say
      try {
        await notify("⏹️ Takip durduruldu", "Bildirimler kesildi. Yeniden başlatmak için cron-job.org'da işi aç.", "https://console.cron-job.org/jobs");
      } catch {}
      return res.json({ stopped: true });
    }

    const events = (process.env.EVENT_URLS || DEFAULT_EVENTS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseEventUrl);

    // Son tarihi geçenleri Passo'ya hiç sorma: geçmiş gösterimler arşive taşınınca hata verir
    const now = new Date();
    const expired = events.filter((e) => e.deadline && hasPassed(e.deadline, now));
    const active = events.filter((e) => !expired.includes(e));

    // Bir etkinliğin hatası diğerlerinin bildirimini engellemesin
    const settled = await Promise.allSettled(active.map(checkEvent));
    const results = settled.map((s, i) =>
      s.status === "fulfilled" ? s.value : { ...active[i], error: String(s.reason?.message || s.reason) }
    );
    // Son tarih verilmemişse bile gösterim saati geçtiyse bildirim gönderme
    for (const r of results) if (r.date && hasPassed(r.date, now)) r.expired = true;
    results.push(...expired.map((e) => ({ ...e, expired: true })));

    const errors = results.filter((r) => r.error).map((r) => r.error);

    // ntfy bildirimine "Bileti aldım" butonu: basınca ?stop=1 ile cron işi kapanır
    const actions =
      process.env.CRONJOB_API_KEY && process.env.CRONJOB_JOB_ID
        ? [
            {
              action: "http",
              label: "Bileti aldım, durdur",
              url: `https://${req.headers.host}/api/check?stop=1`,
              method: "POST",
              ...(secret && { headers: { Authorization: `Bearer ${secret}` } }),
              clear: true,
            },
          ]
        : undefined;

    for (const r of results.filter((r) => r.available && !r.expired)) {
      // Passo saatleri zaten Türkiye saati, saat dilimi dönüşümü yapmadan göster
      const [d, t] = r.date.split("T");
      const when = `${d.split("-").reverse().join(".")} ${t.slice(0, 5)}`;
      // Bir bildirimin hatası sonraki etkinliklerin bildirimini engellemesin
      try {
        await notify(`🎟️ Bilet açıldı: ${r.name}`, `${r.venue} · ${when}`, r.url, actions);
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
