# Passo Bilet Takip

Passo'da tükenen bir gösterime bilet açılınca telefona bildirim gönderir. Tamamen ücretsizdir:
**Vercel** (kontrol fonksiyonu) + **cron-job.org** (dakikada bir tetikleme) + **ntfy** (push bildirim).

## Biletin açıldığını nasıl anlıyor?

passo.com.tr bir Angular uygulaması. Etkinlik sayfasını açtığında tarayıcı, Passo'nun şu API'sinden etkinlik bilgisini çeker:

```
https://ticketingweb.passo.com.tr/api/passoweb/geteventdetails/<seo-url>/<etkinlik-id>/118
```

Yanıtta `isAvailable` alanı bulunur. Site "Bilet Al" butonunu bu alana göre gösterir:

```json
{ "value": { "name": "Fjord", "venueName": "Cinewam City's 7 Sineması", "isAvailable": false, ... } }
```

`api/check.js` her çağrıldığında aynı isteği atar. `isAvailable` `true` olursa bildirim gönderir.
Passo bu alanı kaldırırsa ya da istek engellenirse (ör. Cloudflare) fonksiyon sessiz kalmaz, 502 hatası döner.

```
cron-job.org ──(her dk)──► Vercel /api/check ──► Passo API: isAvailable?
                                                   ├─ false → hiçbir şey yapma
                                                   └─ true  → ntfy → telefona bildirim
```

## Testler ve CI/CD

```bash
npm test            # birim testleri (Passo ve ntfy taklit edilir, internet gerekmez)
npm run test:live   # gerçek Passo API'sinin hâlâ isAvailable döndürdüğünü kontrol eder
```

GitHub Actions (`.github/workflows/ci.yml`):
- Her push/PR'da birim testleri ve canlı API testi çalışır.
- Canlı test her sabah da çalışır; Passo API'yi değiştirirse GitHub e-posta atar.
- `main`'e push edildiğinde birim testleri geçerse Vercel'e production deploy yapılır.
  (Vercel'in kendi Git deploy'u `vercel.json`'da kapatıldı; deploy sadece testler geçince olur.)

## Kurulum

### 1. Bildirim kanalı (ntfy)
1. Telefona **ntfy** uygulamasını kur (Android / iOS).
2. `+` ile bir konuya abone ol. Konu adını tahmin edilemez yap, örn. `yusuf-passo-8f3k2q`
   (ntfy'da konu adını bilen herkes mesajları görebilir; bu yüzden konu adı kodda değil, ortam değişkeninde).

### 2. Vercel projesi
```bash
npx vercel login
npx vercel link          # projeyi oluşturur, .vercel/project.json yazar
npx vercel env add NTFY_TOPIC production
npx vercel env add CRON_SECRET production    # rastgele uzun bir şifre
# opsiyonel: npx vercel env add EVENT_URLS production   (virgülle ayrılmış Passo linkleri)
```

### 3. GitHub secret'ları (deploy için)
1. https://vercel.com/account/tokens adresinden bir token oluştur.
2. Secret'ları ekle (`orgId` ve `projectId` değerleri `.vercel/project.json` içinde):
```bash
gh secret set VERCEL_TOKEN        # token'ı yapıştır
gh secret set VERCEL_ORG_ID       # orgId
gh secret set VERCEL_PROJECT_ID   # projectId
```
3. Actions sekmesinden iş akışını yeniden çalıştır ya da `main`'e push et.

Test et (telefona "Test bildirimi" gelmeli):
```
https://<proje-adın>.vercel.app/api/check?key=<CRON_SECRET>&test=1
```

### 4. Zamanlayıcı (cron-job.org)
Vercel'in ücretsiz planı cron'u günde yalnızca 1 kez çalıştırır, o yüzden ücretsiz **cron-job.org** kullanıyoruz:
1. cron-job.org'a kaydol → **Create cronjob**.
2. URL: `https://<proje-adın>.vercel.app/api/check?key=<CRON_SECRET>`
3. Sıklık: her 1 dakika.
4. **Notifications** kısmından "job fails" için e-posta bildirimini aç.

## Son tarih
`EVENT_URLS` içindeki her linkin yanına `|` ile bir son tarih (Türkiye saati) yazılabilir:

```
https://www.passo.com.tr/tr/etkinlik/.../13157320|2026-10-09T16:00, https://www.passo.com.tr/tr/etkinlik/.../13138330|2026-10-18T21:30
```

Son tarihi geçen gösterim Passo'ya hiç sorulmaz. Böylece arşive taşınan geçmiş gösterimler hata vermez.
Son tarih yazılmasa da, Passo'daki gösterim saati geçmiş bir etkinlik için bildirim gönderilmez.

## Notlar
- Bilet açık olduğu sürece her kontrolde bildirim gelir (bilet kaçmasın diye bilerek böyle). Bileti aldıktan sonra ntfy bildirimindeki **"Bileti aldım, durdur"** butonuna bas (aşağıya bak) ya da cron-job.org'da işi elle durdur.
- Telegram tercih edersen `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` ekleyebilirsin.

## WhatsApp bildirimi (opsiyonel, ücretsiz)
[CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/) kişisel kullanım için ücretsiz WhatsApp mesajı gönderir. ntfy ile birlikte çalışır; ikisi de ayarlıysa ikisine de mesaj gider.

1. CallMeBot sayfasındaki bot numarasını rehbere ekle.
2. Bu numaraya WhatsApp'tan `I allow callmebot to send me messages` yaz.
3. Gelen mesajdaki API anahtarını al ve Vercel'e ekle:
```bash
npx vercel env add WHATSAPP_PHONE production      # örn. +905551112233
npx vercel env add CALLMEBOT_APIKEY production
```
4. Yeni değişkenlerin devreye girmesi için Actions'tan iş akışını yeniden çalıştır (`gh workflow run ci.yml`).

Not: CallMeBot üçüncü taraf, gayriresmî bir servis; mesajlar onun üzerinden geçer ve zaman zaman gecikebilir. Bu yüzden ntfy'ı yedek olarak açık tut.

## "Bileti aldım" butonu (opsiyonel)
ntfy bildirimine bir buton eklenir. Basınca fonksiyon cron-job.org API'siyle zamanlayıcı işini kapatır, bildirimler kesilir ve "Takip durduruldu" onayı gelir.

1. cron-job.org → **Settings** → **API** kısmından bir API anahtarı oluştur.
2. İşin ID'sini bul (işi düzenleme sayfasının adresindeki sayı, ya da `curl -H "Authorization: Bearer <anahtar>" https://api.cron-job.org/jobs`).
3. Vercel'e ekle ve yeniden deploy et:
```bash
npx vercel env add CRONJOB_API_KEY production
npx vercel env add CRONJOB_JOB_ID production
gh workflow run ci.yml
```

Takibi yeniden başlatmak için cron-job.org'da işi tekrar aç. WhatsApp mesajlarında buton yok, ama iş kapanınca onlar da kesilir.
