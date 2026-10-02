// Gerçek Passo API'sine istek atar: API biçimi değişirse ya da istek engellenirse bu test kırılır.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventUrl, checkEvent } from "../api/check.js";

const FJORD = "https://www.passo.com.tr/tr/etkinlik/fjord-iksv-filmekimi-citys7-film-biletleri/13138330";

test("Passo API hâlâ isAvailable döndürüyor", async () => {
  const r = await checkEvent(parseEventUrl(FJORD));
  assert.equal(r.name, "Fjord");
  assert.equal(typeof r.available, "boolean");
  console.log(`Fjord bilet durumu: ${r.available ? "AÇIK" : "yok"}`);
});
