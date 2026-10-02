import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import handler, { parseEventUrl, checkEvent } from "../api/check.js";

const FJORD = "https://www.passo.com.tr/tr/etkinlik/fjord-iksv-filmekimi-citys7-film-biletleri/13138330";
const OTHER = "https://www.passo.com.tr/tr/etkinlik/ideal-koca-iksv-filmekimi-paribu-art-film-biletleri/13341319";

const realFetch = globalThis.fetch;
let passoResponses; // id -> yanıt gövdesi (string ya da obje)
let sent; // ntfy/telegram'a giden istekler

function passoEvent(id, isAvailable) {
  return {
    value: { id, name: `Film ${id}`, date: "2026-10-18T21:30:00", venueName: "Salon", isAvailable },
  };
}

beforeEach(() => {
  passoResponses = {};
  sent = [];
  process.env.NTFY_TOPIC = "test-topic";
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.WHATSAPP_PHONE;
  delete process.env.CALLMEBOT_APIKEY;
  delete process.env.CRON_SECRET;
  delete process.env.EVENT_URLS;

  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith("https://ticketingweb.passo.com.tr/")) {
      const id = url.match(/\/(\d+)\/\d+$/)[1];
      const body = passoResponses[id] ?? "";
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
    }
    sent.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    return new Response("{}", { status: 200 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function call(query = {}, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      setHeader() {},
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    handler({ query, headers }, res);
  });
}

test("parseEventUrl: slug ve id'yi ayıklar", () => {
  assert.deepEqual(parseEventUrl(FJORD), {
    url: FJORD,
    slug: "fjord-iksv-filmekimi-citys7-film-biletleri",
    id: "13138330",
  });
});

test("parseEventUrl: sorgu parametreli linki de kabul eder", () => {
  assert.equal(parseEventUrl(`${FJORD}?utm_source=x`).id, "13138330");
});

test("parseEventUrl: Passo etkinlik linki değilse hata verir", () => {
  assert.throws(() => parseEventUrl("https://example.com/foo"), /Geçersiz Passo linki/);
});

test("checkEvent: isAvailable alanını okur", async () => {
  passoResponses["13138330"] = passoEvent(13138330, false);
  const r = await checkEvent(parseEventUrl(FJORD));
  assert.equal(r.available, false);
  assert.equal(r.name, "Film 13138330");
});

test("checkEvent: Passo JSON yerine HTML dönerse (ör. Cloudflare) hata verir", async () => {
  passoResponses["13138330"] = "<html>Attention Required! | Cloudflare</html>";
  await assert.rejects(checkEvent(parseEventUrl(FJORD)), /JSON dönmedi/);
});

test("checkEvent: isAvailable alanı yoksa hata verir", async () => {
  passoResponses["13138330"] = { value: { id: 13138330, name: "Fjord" } };
  await assert.rejects(checkEvent(parseEventUrl(FJORD)), /isAvailable alanı yok/);
});

test("handler: bilet yoksa bildirim göndermez", async () => {
  passoResponses["13138330"] = passoEvent(13138330, false);
  const { status, body } = await call();
  assert.equal(status, 200);
  assert.equal(body.results[0].available, false);
  assert.equal(sent.length, 0);
});

test("handler: bilet açıldıysa ntfy bildirimi gönderir", async () => {
  passoResponses["13138330"] = passoEvent(13138330, true);
  const { status } = await call();
  assert.equal(status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://ntfy.sh");
  assert.equal(sent[0].body.topic, "test-topic");
  assert.match(sent[0].body.title, /Bilet açıldı: Film 13138330/);
  assert.equal(sent[0].body.message, "Salon · 18.10.2026 21:30");
  assert.equal(sent[0].body.click, FJORD);
});

test("handler: birden çok etkinlikte sadece açılan için bildirim gönderir", async () => {
  process.env.EVENT_URLS = `${FJORD}, ${OTHER}`;
  passoResponses["13138330"] = passoEvent(13138330, false);
  passoResponses["13341319"] = passoEvent(13341319, true);
  const { body } = await call();
  assert.equal(body.results.length, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.click, OTHER);
});

test("handler: Telegram ayarlıysa oraya da gönderir", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:abc";
  process.env.TELEGRAM_CHAT_ID = "42";
  passoResponses["13138330"] = passoEvent(13138330, true);
  await call();
  assert.equal(sent.length, 2);
  const tg = sent.find((s) => s.url.includes("api.telegram.org/bot123:abc/sendMessage"));
  assert.equal(tg.body.chat_id, "42");
});

test("handler: WhatsApp (CallMeBot) ayarlıysa oraya da gönderir", async () => {
  process.env.WHATSAPP_PHONE = "+905551112233";
  process.env.CALLMEBOT_APIKEY = "999";
  passoResponses["13138330"] = passoEvent(13138330, true);
  await call();
  assert.equal(sent.length, 2);
  const wa = new URL(sent.find((s) => s.url.startsWith("https://api.callmebot.com/whatsapp.php")).url);
  assert.equal(wa.searchParams.get("phone"), "+905551112233");
  assert.equal(wa.searchParams.get("apikey"), "999");
  assert.equal(wa.searchParams.get("text"), `*🎟️ Bilet açıldı: Film 13138330*\nSalon · 18.10.2026 21:30\n${FJORD}`);
});

test("handler: sadece WhatsApp ayarlıysa da çalışır", async () => {
  delete process.env.NTFY_TOPIC;
  process.env.WHATSAPP_PHONE = "+905551112233";
  process.env.CALLMEBOT_APIKEY = "999";
  passoResponses["13138330"] = passoEvent(13138330, true);
  const { status } = await call();
  assert.equal(status, 200);
  assert.equal(sent.length, 1);
});

test("handler: CRON_SECRET yanlışsa 401 döner", async () => {
  process.env.CRON_SECRET = "gizli";
  const { status } = await call({ key: "yanlis" });
  assert.equal(status, 401);
});

test("handler: CRON_SECRET query ya da Bearer header ile kabul edilir", async () => {
  process.env.CRON_SECRET = "gizli";
  passoResponses["13138330"] = passoEvent(13138330, false);
  assert.equal((await call({ key: "gizli" })).status, 200);
  assert.equal((await call({}, { authorization: "Bearer gizli" })).status, 200);
});

test("handler: test=1 test bildirimi gönderir", async () => {
  const { body } = await call({ test: "1" });
  assert.deepEqual(body, { test: "sent" });
  assert.equal(sent[0].body.title, "Test bildirimi");
});

test("handler: Passo hatasında 502 döner", async () => {
  passoResponses["13138330"] = "<html>Cloudflare</html>";
  const { status, body } = await call();
  assert.equal(status, 502);
  assert.match(body.error, /JSON dönmedi/);
});

test("handler: bildirim kanalı yoksa bilet açıkken 502 döner", async () => {
  delete process.env.NTFY_TOPIC;
  passoResponses["13138330"] = passoEvent(13138330, true);
  const { status, body } = await call();
  assert.equal(status, 502);
  assert.match(body.error, /Bildirim kanalı yok/);
});
