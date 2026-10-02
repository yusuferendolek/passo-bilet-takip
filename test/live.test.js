// Gerçek Passo API'sine istek atar: API biçimi değişirse ya da istek engellenirse bu test kırılır.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventUrl, checkEvent, hasPassed } from "../api/check.js";

const FJORD = "https://www.passo.com.tr/tr/etkinlik/fjord-iksv-filmekimi-citys7-film-biletleri/13138330";
const FJORD_DATE = "2026-10-18T21:30";

// Gösterim geçince Passo etkinliği arşive taşır; o zaman bu test anlamını yitirir
test("Passo API hâlâ isAvailable döndürüyor", { skip: hasPassed(FJORD_DATE) && "Fjord gösterimi geçti" }, async () => {
  const r = await checkEvent(parseEventUrl(FJORD));
  assert.equal(r.name, "Fjord");
  assert.equal(typeof r.available, "boolean");
  console.log(`Fjord bilet durumu: ${r.available ? "AÇIK" : "yok"}`);
});
