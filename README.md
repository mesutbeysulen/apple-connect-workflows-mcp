# Apple Connect Workflows MCP

Apple App Store Connect için yerel çalışan TypeScript MCP sunucusu. Geliştirilen kapsam:
**hesap/uygulama okuma, kalıcı sürüm metni planları, Asset Library görsel akışı, Header ve Search
Results varlıkları, IPA yükleme, TestFlight, incelemeye gönderme ve yayın, IAP/abonelik/fiyat, satış ve
analitik raporları, webhook'lar, anahtar kurulumu, yerel yetkiler ve API kataloğu**.

Bu proje magaza-mcp analizinden hareketle sıfırdan geliştirilmiştir; onun fork'u değildir.
Apple ile bağlantılı resmi bir ürün değildir. Henüz npm'e yayımlanmaz (`private: true`).

## Lisans

[MIT](LICENSE). Bu ilk sürümde gerçek Apple hesabıyla uçtan uca doğrulama yapılmadı;
deneme uygulamasında başlayın.

## Çalışan kapsam

| Araç | İşlev |
| --- | --- |
| `accounts_list` | Hesap adları, salt okunur durumu ve yazma kapsamı; bağlantı testi yapmaz |
| `account_check` | Minimal uygulama okuma isteğiyle kimlik doğrulama testi |
| `apps_list` | Uygulamalar; isteğe bağlı tam bundle ID filtresi |
| `versions_list` | Uygulamanın sürümleri ve durumları |
| `builds_list` | Mevcut build'ler ve işlenme durumları |
| `localizations_list` | Bir sürümün mevcut dil kayıtları |
| `screenshot_sets_list` | Bir lokalizasyondaki ekran görüntüsü kümeleri |
| `screenshot_status` | Yüklenen ekran görüntüsünün Apple işlenme durumu |
| `build_uploads_list` | Uygulamanın build yükleme işlemleri ve durumları |
| `build_upload_status` | Bir build yüklemesinin Apple işlenme durumu |
| `asset_library_images` | Uygulamanın Asset Library görselleri; durum filtresi |
| `asset_image_status` | Tek Asset Library görselinin durumu ve yerleşimleri |
| `asset_placements_list` | Lokalizasyondaki yerleşimler, gösterim sırasıyla |
| `asset_ref_data` | Apple'ın yerleşim türü, grup, ekran sınıfı ve görsel spec referansları |
| `asset_cleanup_preview` | Yarım kalmış/başarısız rezervasyonların kuru çalıştırma listesi; silmez |
| `beta_groups_list` | Uygulamanın TestFlight grupları |
| `build_processing_status` | Yüklemenin ve işlenen build'in tek seferlik durumu |
| `beta_feedback_list` | TestFlight ekran görüntülü veya çökme geri bildirimleri |
| `beta_crash_log` | Bir çökme geri bildiriminin log metni |
| `creative_status` | Header/Search Results varlığının durumu ve yerleşimleri |
| `creative_overview` | Bir sürümün her dilindeki Header ve Search Results yerleşimleri |
| `release_readiness` | İnceleme öncesi engel ve uyarı raporu |
| `review_submissions_list`, `review_submission_items` | App Review gönderimleri ve içerikleri |
| `iap_list`, `subscription_groups_list`, `subscriptions_list`, `subscription_prices_list` | IAP ve abonelik verileri |
| `analytics_requests_list`, `analytics_reports_list` | Analitik rapor istekleri ve raporları |
| `webhooks_list`, `webhook_deliveries_list`, `webhook_events_list` | Webhook'lar, teslimatlar, yerelde alınan olaylar |
| `audit_log_list` | Yerel CLI yazma kayıtları |
| `api_catalog_search`, `api_read` | API kataloğunda arama ve katalogdaki herhangi bir GET ucunu okuma |
| `metadata_plan` | Açıklama, sürüm notu, anahtar kelime ve promosyon metni için önce/sonra planı |
| `plan_get` | Plan, SHA-256 özeti, süre ve yürütme durumu |
| `workflow_catalog` | MCP üzerinden kullanılabilen CLI iş akışları ve gereken yetki sınıfları |
| `workflow_run` | Salt okuma, build bekleme ve rapor indirme komutları |
| `workflow_prepare`, `workflow_plan_get`, `workflow_apply` | Yazma işlemini planla, incele ve tek sefer uygula |

Plan oluşturmak Apple'a yazmaz; yerel SQLite'a kaydeder. `workflow_prepare`, mümkün olan
komutlarda Apple verisine dayalı önizleme üretir; diğerlerinde yalnızca gönderilecek girdileri
gösterir. `workflow_apply`, 30 dakika geçerli planın SHA-256 özetini ister ve planı bir kez
çalıştırır. Belirsiz sonuçlanan işlemler otomatik tekrar edilmez; durumu Apple'dan kontrol edip
yeni plan hazırlayın. Dosya veya klasör girdileri değişirse uygulama reddedilir. CLI'nin yerel
operatör yetkileri, hesap/uygulama izinleri, kilidi ve denetim kaydı aynen uygulanır. MCP host'unun
kullanıcı onayı ayrıca yapılandırılmalıdır; özet tek başına insan onayı kanıtı değildir.

`key-setup` ve `webhook-listen` sunucu kurulumu/arka plan işlemi olduğu için MCP akışına dahil
değildir. Genel API okuma ve yazma planları mevcut `api_read`, `api_write_plan` ve
`workflow_prepare` üzerinden `api-apply` ile yürütülür.

Örnek MCP yazma akışı:

```json
{"command":"version-localize","args":{"account":"main","app":"123456789","version":"VERSION_ID","locale":"tr-TR","whats-new":"Yeni özellikler"}}
```

Bu girdiyi `workflow_prepare` aracına verin. Dönen `id` ve `digest` değerlerini
`workflow_plan_get` ile inceleyin; sonra `workflow_apply` aracına
`{"planId":"ID","digest":"SHA256"}` verin. `workflow_catalog` tüm komut adlarını listeler;
argüman anahtarları CLI'deki `--` işareti olmadan yazılır.

## Kurulum

Node.js **24 veya üstü** gerekir (`node:sqlite`).

```sh
npm ci
npm run build
```

App Store Connect API anahtarınızın `.p8` dosyasını ve **team** anahtarı için issuer ID'yi
hazırlayın. `key-setup` anahtarı yalnızca sizin okuyabileceğiniz bir klasöre kopyalar ve
`config.local.json` dosyasını oluşturur. Dosya adınız `AuthKey_XXXXXXXXXX.p8` biçiminde değilse
`--key-id XXXXXXXXXX` ekleyin. İlk kurulum yazma izni olmadan başlar:

```sh
node dist/cli.js key-setup --config "$PWD/config.local.json" --name main \
  --issuer ISSUER_UUID --p8 /absolute/path/AuthKey_ABCDEFGHIJ.p8
```

**Individual API key** için `--issuer ISSUER_UUID` yerine `--individual` verin.
Elle yapılandırmayı tercih ederseniz `cp config.example.json config.local.json` çalıştırıp
örnek issuer ID, key ID ve tüm mutlak yolları gerçek değerlerle değiştirin.
`.p8` içeriğini config'e veya sohbete yapıştırmayın. Keychain aktarımı desteklenmez.

```sh
export APPLE_CONNECT_CONFIG="$PWD/config.local.json"
node dist/cli.js doctor
node dist/cli.js serve
```

`doctor`, her hesabın apps endpoint erişimini kontrol eder; diğer endpoint rollerini doğruladığı
anlamına gelmez. `serve` stdout'u sadece MCP protokolü için kullanır.

MCP istemcinize sunucu tanımlarken çalıştırılabilir dosya olarak `node`, argüman olarak
`/absolute/path/to/apple-connect-workflows-mcp/dist/cli.js`, `serve` verin. JSON konfigürasyon kullanan
istemciler için örnek:

```json
{
  "mcpServers": {
    "apple-connect": {
      "command": "node",
      "args": ["/absolute/path/to/apple-connect-workflows-mcp/dist/cli.js", "serve"],
      "env": { "APPLE_CONNECT_CONFIG": "/absolute/path/to/apple-connect-workflows-mcp/config.local.json" }
    }
  }
}
```

JSON örneğindeki iki mutlak yolu kendi makinenizdeki gerçek yollarla değiştirin. `npm run build`
sonrası `dist/cli.js` oluşmalıdır. MCP istemcisini baştan başlatın; `accounts_list` ile hesabın
göründüğünü ve `account_check` ile Apple erişimini doğrulayın. `doctor` ve `account_check` yalnızca
uygulama listeleme erişimini doğrular; her Apple API yetkisini doğrulamaz.

İstemciyi bu projeden farklı bir çalışma dizininde başlatabilirsiniz; tüm yapılandırma yolları mutlaktır.
İstemcinin farklı bir config formatı varsa aynı komut, argüman ve ortam değişkenlerini kullanın.

## Metin değişikliği örneği

Önce `versions_list` ve `localizations_list` ile gerçek kimlikleri bulun. Mevcut olmayan dil kayıtları
bu sürümde otomatik oluşturulmaz. MCP çağrısı:

```json
{
  "account": "main",
  "appId": "1234567890",
  "versionId": "REAL-VERSION-ID",
  "localizations": [
    { "locale": "tr", "changes": { "whatsNew": "Performans iyileştirmeleri ve hata düzeltmeleri." } }
  ]
}
```

Bu girdiyi `metadata_plan` aracına verin. Plan yalnızca değişen alanları içerir ve 30 dakika geçerlidir.
Sonuçtaki `id` ve `digest` değerlerini kullanın:

```sh
node dist/cli.js plan --plan PLAN_ID
```

İçeriği inceledikten sonra hesabın config kaydında `readOnly: false` ve
`allowedAppIds: ["1234567890"]` tanımlayın; ardından:

```sh
node dist/cli.js apply --plan PLAN_ID --digest REVIEWED_SHA256
```

Apply planın hesabını, izin verilen uygulamayı, sürümün uygulamaya ait oluşunu ve düzenlenebilir
durumunu kontrol eder. Uzaktaki ilgili alanlar önizlemedeki değerlerden farklıysa yazmaz.
PATCH sonrası Apple'dan tekrar okuyarak sonucu doğrular. İlgisiz alanları göndermez.

Kesintide aynı komutu plan süresi içinde tekrar çalıştırabilirsiniz. Önce uzaktaki sonuç okunur:
istenen değer zaten mevcutsa adım tamamlanmış sayılır; eski değer varsa tekrar denenir;
başka bir değer varsa çakışma bildirilir. Süre geçtiyse yeni plan oluşturun.

## Görsel akışı: Asset Library (önerilen)

Apple 6 Ekim 2026'da `appScreenshots` uçlarını kullanımdan kaldırılmış (deprecated) ilan etti ve
App Store Connect API 4.6 ile **App Asset Library** uçlarını getirdi. Yeni yüklemeler için bu akışı
kullanın. Görsel önce uygulamanın kütüphanesine yüklenir, sonra bir sürüm lokalizasyonuna
**placement** olarak yerleştirilir.

`placementGroup` değerini tahmin etmeyin: `asset_placements_list` ile mevcut yerleşimlerden
veya `asset_ref_data` ile Apple referans verisinden alın. Yerel olarak sadece biçimi kontrol edilir.

```sh
node dist/cli.js asset-upload --account main --app 1234567890 \
  --version REAL_VERSION_ID --localization REAL_LOCALIZATION_ID \
  --placement-group REAL_GROUP --file /absolute/path/to/screenshot.png
```

İsteğe bağlı bayraklar: `--placement-type APP_SCREENSHOT` ve `--reference-name "Ana ekran"`.

Komut sürüm/uygulama/lokalizasyon ilişkisini ve düzenlenebilir durumu doğrular, PNG/JPEG imzasını
kontrol eder, `APP_SCREENSHOTS_AND_PREVIEWS` kategorisinde rezervasyon açar, rezervasyonu SQLite'a
yazar, byte aralıklarını Apple'ın imzalı adreslerine gönderir, `uploaded: true` ile tamamlar ve
yerleşimi oluşturur. Kesintide hata metnindeki `Asset job` kimliğiyle devam edin:

```sh
node dist/cli.js asset-resume --account main --image REAL_IMAGE_ID
```

Devam komutu dosyanın SHA-256 özetini doğrular, yeni rezervasyon açmaz ve yerleşim oluşturmadan önce
aynı görselin bu lokalizasyonda zaten yerleşip yerleşmediğine bakar; cevabı kaybolan yerleşim çift
oluşturulmaz. Apple görseli işlemeye devam ederken yerleşim `ASSET_PROCESSING` durumunda olabilir;
`asset_image_status` ile izleyin.

### Sıralama

`asset_placements_list` ile güncel sırayı ve ID'leri alın. Yeni sıra, gruptaki **bütün** yerleşimleri
tam olarak bir kez içermelidir; eksik, fazla veya tekrarlı liste reddedilir. Sıra zaten aynıysa
yazma yapılmaz (`unchanged`). Yazmadan sonra sıra Apple'dan tekrar okunarak doğrulanır.

```sh
node dist/cli.js asset-order --account main --app 1234567890 --version REAL_VERSION_ID \
  --localization REAL_LOCALIZATION_ID --placement-group REAL_GROUP --order PL_3,PL_1,PL_2
```

### Yarım kalmış rezervasyonların temizlenmesi

```sh
node dist/cli.js asset-cleanup --account main --app 1234567890
node dist/cli.js asset-cleanup --account main --app 1234567890 --execute
```

Eşiği değiştirmek için ilk komuta `--older-than-hours 24` ekleyin.

Varsayılan kuru çalıştırmadır; sadece adayları listeler (MCP'de `asset_cleanup_preview`). Aday:
`AWAITING_UPLOAD` veya `FAILED` durumunda, eşik süresinden eski ve hiçbir yere yerleşmemiş Asset
Library görseli. Eski `appScreenshots` rezervasyonlarından yalnızca bu aracın günlüğüne
oluşturma zamanıyla yazılmış olanlar değerlendirilir. `--execute` yazma izni ister ve her adayı
silmeden hemen önce tekrar okur; durum değiştiyse veya görsel yerleştiyse atlar. Apple'ın
verdiği oluşturma tarihi yoksa görsel silinmez. Apple'ın yardım sayfası yalnızca *Prepared for
Submission* durumundaki varlıkların silinebildiğini söylüyor; Apple silmeyi reddederse varlık arşivlenir ve
rapordaki `archived` listesinde görünür. Videolar da aynı kurallarla temizlenir.

## Header ve Search Results

Bu varlıklar (`PRODUCT_PAGE_HEADER_ASSET`, `APP_STORE_SEARCH_RESULTS_ASSET`) iOS 27 ve iPadOS 27 ile
görünür, ekran görüntüsünün yerine geçmez ve isteğe bağlıdır. Görsel veya video olabilir. Akış üç adımdır:

```sh
# 1. Yükle. Kütüphaneye gider; henüz bir yere yerleşmez ve incelemeye gitmez.
node dist/cli.js creative-upload --account main --app 1234567890 \
  --placements header,search --file /absolute/path/to/hero.png

# 2. creative_status ile durumu izleyin; PREPARE_FOR_SUBMISSION olunca incelemeye gönderin.
node dist/cli.js creative-submit --account main --app 1234567890 --images REAL_IMAGE_ID

# 3. Sürümün dil kaydına yerleştirin.
node dist/cli.js creative-place --account main --app 1234567890 --version REAL_VERSION_ID \
  --localization REAL_LOCALIZATION_ID --placements header,search --image REAL_IMAGE_ID
```

- `creative-upload`, ölçü ve dosya kurallarını sabit kodlamaz; Apple'ın `appAssetLibraryRefData` verisinden
  okur. PNG/JPEG ölçüsü veya alfa kanalı uymuyorsa rezervasyon açmadan durur ve Apple'ın kurallarını yazar.
  `header,search` birlikte verilirse dosya ikisine de uymalıdır (evrensel varlık). Video ölçü ve süresi
  yerelde okunmaz; Apple doğrular.
- Kesintide `creative-resume --account main --asset ID` aynı rezervasyondan devam eder.
- `creative-submit` tek başına inceleme gönderimidir, yeni sürüm gerektirmez. Apple'da bekleyen taslakta
  başka öğeler varsa göndermez, çünkü onları da incelemeye yollamış olurdu. Tekrar çalıştırmak güvenlidir.
- `creative-place` zaten yerleşmiş varlığı tekrar yerleştirmez. O konumda başka varlık varsa `--replace`
  olmadan değiştirmez. `--replace` önce yenisini eklemeyi dener, sonra eskisini kaldırır. Apple yer sınırı
  nedeniyle reddederse eskisini kaldırıp yeniden dener; yine başarısız olursa eskisini geri yerleştirmeyi dener ve
  sonucu yazar. Sonucu belirsiz bir hatada (bağlantı kopması gibi) eskisine dokunmaz. Birden çok yerleşim
  varsa `--placement-group` ister. Varlıklar kütüphanede kalır.
- Düzenlenebilir olmayan (örn. yayındaki) sürüm yalnızca `APPROVED` varlık kabul eder; komut bunu yazmadan önce söyler.
- `creative-remove` yerleşimi kaldırır, varlığı silmez. `--placement-group` isteğe bağlıdır.
- Custom Product Page, ürün sayfası optimizasyonu ve in-app event yerleşimleri bu sürümde yoktur.

## Eski screenshot set akışı

`appScreenshots` uçları kullanımdan kaldırıldı ama henüz kapatılmadı; mevcut set'ler için korunur.

```sh
node dist/cli.js screenshot-set-create --account main --app 1234567890 \
  --version REAL_VERSION_ID --localization REAL_LOCALIZATION_ID --display-type APP_IPHONE_67
node dist/cli.js screenshot-upload --account main --app 1234567890 \
  --version REAL_VERSION_ID --localization REAL_LOCALIZATION_ID \
  --set REAL_SET_ID --file /absolute/path/to/screenshot.png
node dist/cli.js screenshot-resume --account main --screenshot REAL_SCREENSHOT_ID
node dist/cli.js screenshot-order --account main --app 1234567890 --version REAL_VERSION_ID \
  --localization REAL_LOCALIZATION_ID --set REAL_SET_ID --order SS_2,SS_1
```

`screenshot-set-create` aynı ekran türünde set varsa onu döndürür (`exists`), tekrar çalıştırmak
güvenlidir. Yükleme sürüm, lokalizasyon ve set sahipliğini doğrular, MD5 özetiyle tamamlar ve
rezervasyonu SQLite'a yazar. `UPLOAD_COMPLETE` Apple'ın hâlâ işlediği anlamına gelir;
`screenshot_status` ile `COMPLETE`/`FAILED` durumunu izleyin. `screenshot-order` set'teki bütün
screenshot ID'lerini ister ve sonucu tekrar okuyarak doğrular. Bu sürümden önce kaydedilen eski
işlerde oluşturma zamanı olmadığından otomatik temizleme bunları atlar.

## IPA build yükleme

İmzalanmış `.ipa` dosyanız hazırsa, uygulama kimliği, `CFBundleShortVersionString` ve
`CFBundleVersion` değerlerini vererek yükleyebilirsiniz:

```sh
node dist/cli.js build-upload --account main --app 1234567890 \
  --version 1.2.3 --build 42 --file /absolute/path/to/app.ipa
```

Komut `.ipa` dosyasının ZIP imzasını ve boyutunu kontrol eder; dosyanın SHA-256 özetini
hesaplar, Apple'da build ve dosya rezervasyonu açar, verilen byte aralıklarını akış halinde
yükler ve dosyayı tamamlar. Sonuç `PROCESSING` olabilir. `build_upload_status` MCP aracıyla
Apple'daki build upload ID'sini sorgulayın; `COMPLETE` olunca `builds_list` ile işlenmiş
build ID'sini bulun. TestFlight dağıtım komutu bu işlenmiş build ID'sini ister.

Yükleme SQLite'a kaydedilir ve gönderilen her parça işaretlenir. Aynı sürüm ve build için Apple'da
başarısız olmayan bir yükleme varsa komut yeni rezervasyon açmaz. Kesintide kalan parçalardan devam edin,
ardından işlenmeyi izleyin. Yerel kaydı olmayan takılı bir rezervasyonu `build-cancel` kaldırır:

```sh
node dist/cli.js build-resume --account main --upload REAL_UPLOAD_ID
node dist/cli.js build-cancel --account main --app 1234567890 --upload REAL_UPLOAD_ID
node dist/cli.js build-wait --account main --upload REAL_UPLOAD_ID --timeout-minutes 60
```

`build-resume` dosyanın değişmediğini SHA-256 ile doğrular. Bir parçayı ancak aynı oturuma ve aynı sınırlarla
gönderilmişse atlar; Apple adresleri yeniden verirse parçayı yeniden gönderir. Apple'ın imzalı adreslerinin süresi dolduysa
hata verir. `build-wait` salt okunurdur; build `VALID`, `INVALID` veya `FAILED` olana ya da süre dolana kadar
bekler ve build ID'sini yazar. Komut hazır `.ipa` dosyasını taşır; Xcode derleme, imzalama veya IPA içindeki
sürümün argümanlarla eşleşmesini doğrulama görevini üstlenmez.

## TestFlight grubuna dağıtım

`builds_list` ile `VALID` işlenme durumundaki build ID'sini, `beta_groups_list` ile grup
ID'sini bulun. Bir build'i gruba atamak için:

```sh
node dist/cli.js testflight-distribute --account main --app 1234567890 \
  --build REAL_BUILD_ID --group REAL_GROUP_ID
```

Komut build ile grubun aynı uygulamaya bağlı olduğunu kontrol eder. Build zaten gruptaysa
`already_assigned` döner. Yeni ilişki eklendiğinde `submitted` döner; Apple'ın dış test
için Beta App Review koşulları ayrıca geçerlidir. Bu komut dış test incelemesi başlatmaz.
Bağlantı hatasından sonra aynı komutu yeniden çalıştırabilirsiniz; önce mevcut grup üyeliğini okur.
`--group A,B` ile birden çok gruba atanır; her grubun sonucu ayrı yazılır, biri başarısız olursa diğerleri
denenir ve çıkış kodu 1 olur. Geri bildirimleri `beta_feedback_list` ve `beta_crash_log` ile okuyun;
bunlar test kullanıcısının e-postasını ve cihaz bilgisini içerir.

## Yayın akışı

```sh
node dist/cli.js release-check --account main --app 1234567890 --version REAL_VERSION_ID
node dist/cli.js release-submit --account main --app 1234567890 --version REAL_VERSION_ID --version-string 1.2.3
node dist/cli.js release-publish --account main --app 1234567890 --version REAL_VERSION_ID --version-string 1.2.3
```

`release-check` (MCP'de `release_readiness`) build, metinler, ekran görüntüsü, inceleme iletişimi, kategori,
yaş derecesi, gizlilik adresi, içerik hakları ve fiyat için engelleri listeler, engel varsa çıkış kodu 1'dir.
App Privacy etiketleri ve her cihaz boyutunun kapsamı kontrol edilemez; rapor bunları `notChecked` altında
açıkça yazar. Temiz rapor Apple'ın kabul edeceği anlamına gelmez.

`release-submit` engel varsa veya `--version-string` sürümle eşleşmiyorsa göndermez. Reddedilen bir sürüm
düzeltildikten sonra aynı komutla mevcut gönderim üzerinden yeniden gönderilir (`resubmitted`); bu davranış
canlıda doğrulanmadı. Cevabı kaybolan gönderimde tekrar çalıştırmak `already_submitted` döner. `release-publish` yalnızca
`PENDING_DEVELOPER_RELEASE` durumundaki sürümü yayınlar ve **geri alınamaz**; zaten yayındaysa yazmaz.
Kademeli yayın durumu `phased-release` komutuyla ayarlanabilir.

## IAP, abonelik ve fiyat

```sh
node dist/cli.js iap-create --account main --app 1234567890 --product-id coins.100 --name "100 Altın" --type CONSUMABLE
node dist/cli.js subscription-group-create --account main --app 1234567890 --name Pro
node dist/cli.js subscription-create --account main --app 1234567890 --group GROUP_ID --product-id pro.month --name "Pro Aylık" --period ONE_MONTH
node dist/cli.js product-localize --account main --app 1234567890 --subscription SUB_ID --locale tr --name "Pro Aylık" --description "Tüm özellikler"
node dist/cli.js iap-price-set --account main --app 1234567890 --iap IAP_ID --territory USA --price 1.99
```

Oluşturma komutları aynı ürün varsa yeniden oluşturmaz. Fiyat komutları (`app-price-set`, `iap-price-set`,
`subscription-price-set`) `--execute` verilmedikçe yalnızca önizleme gösterir. Fiyat, Apple'ın fiyat
noktalarıyla birebir eşleşmelidir; eşleşmezse yuvarlamaz, en yakın değerleri listeler. Çıktının `current` alanı
değiştirilecek fiyatları gösterir, bu çıktıyı saklayın. Uygulama ve IAP fiyat
planı gönderimi **mevcut manuel planın tamamını değiştirir**. Abonelikte `--preserve-current-price` mevcut
aboneleri eski fiyatta tutar. Bu komutlar ürünleri incelemeye göndermez.

## Satış ve analitik raporları

```sh
node dist/cli.js sales-download --account main --vendor 85000000 --type SALES --subtype SUMMARY \
  --frequency DAILY --from 2026-10-01 --to 2026-10-31 --out /absolute/path/sales.tsv
node dist/cli.js analytics-request --account main --app 1234567890
node dist/cli.js analytics-download --account main --app 1234567890 --report-name "App Downloads Standard" \
  --granularity DAILY --from 2026-10-01 --out /absolute/path/analytics.tsv
```

Raporlar tek TSV dosyasında birleştirilir: farklı sütunlar korunur, her satıra kaynak dönem sütunu eklenir,
dosya yalnızca sahibine açık yazılır. Apple'da verisi olmayan dönemler `missing` altında listelenir; hiç veri
yoksa dosya yazılmaz, mevcut dosya korunur. Hata ortasında biten dönemler `ÇIKTI.partial` dosyasına kaydedilir.
Aynı tarih birden çok rapor isteğinde varsa `ONGOING` kullanılır, böylece toplamlar iki kez sayılmaz. Analitik
parçaları MD5 ile doğrulanır. Yeni analitik isteğinin ilk verisi bir gün veya daha geç gelebilir. Finans
raporları bu sürümde yoktur.

## Ekip kullanımı

**Anahtar kurulumu:** Yukarıdaki `key-setup` komutu `.p8` dosyasını doğrular,
`~/.apple-connect-mcp/keys` altına yalnızca size açık kopyalar ve hesabı config'e ekler.
İlk kurulumda `--allow-app 1234567890` eklerseniz hesap bu uygulama için yazmaya açılır.
Hesabı zaten kurduysanız aynı `--name` ile `key-setup` komutunu tekrar çalıştırmayın;
`config.local.json` içinde `readOnly` değerini `false`, `allowedAppIds` değerini ilgili
uygulama ID'leri yapın. Anahtar içeriği yazdırılmaz. Keychain desteği yoktur.

**Yerel yetkiler:** Config'e `operators` eklenirse Apple'a yazan CLI komutları işletim sistemi kullanıcısına
göre sınırlanır. Yetkiler: `upload`, `review`, `release`, `commercial`, `admin`. `operators` yoksa davranış
değişmez. Bu **kimlik doğrulama değildir**: anahtarı okuyabilen biri `--config` veya `APPLE_CONNECT_CONFIG` ile
`operators` içermeyen başka bir dosya göstererek kuralı atlayabilir. Gerçek ayrım için anahtarı işletim sistemi
izinleriyle koruyun.
Uzak veya sunucu tabanlı çok kullanıcılı erişim yoktur. Yazma komutları `audit` komutuyla okunan yerel bir
kayda düşer.

```json
{ "operators": [
  { "user": "ayse", "accounts": ["main"], "capabilities": ["upload", "review"] },
  { "user": "mehmet", "accounts": ["*"], "capabilities": ["upload", "review", "release", "commercial", "admin"] }
] }
```

**Eşzamanlı yazma:** Apple'a yazan her CLI komutu hesap ve uygulama başına aynı kilidi tutar. Aynı veritabanını
kullanan ikinci bir yazma, ilki bitene kadar hata ile reddedilir; paralel yükleme yerine sırayla çalıştırın.

**Gizli alanlar:** MCP çıktılarında parola, demo hesap adı, gizli değer, sertifika ve profil içerikleri `[redacted]` olur.

**Webhook'lar:** Gizli değer yalnızca `APPLE_WEBHOOK_SECRET` ortam değişkeninden okunur (en az 16 karakter).
Aynı ad ve adresle `webhook-create` yeniden çalışırsa gizli değeri günceller (`secret_updated`).
`webhook-listen` `127.0.0.1` üzerinde dinler, imzası (`x-apple-signature`) doğrulanan olayları SQLite'a yazar;
HTTPS tüneli veya proxy sizin kurulumunuzdur. İmzanın ham gövde üzerinden hesaplandığı varsayılmıştır; Apple
bunu açıkça yazmıyor, `webhook-ping` ile gerçek bir teslimatta doğrulayın.

```sh
export APPLE_WEBHOOK_SECRET="..."
node dist/cli.js webhook-create --account main --app 1234567890 --name ci \
  --url https://hooks.example.com/apple --events BUILD_UPLOAD_STATE_UPDATED,BETA_FEEDBACK_CRASH_SUBMISSION_CREATED
node dist/cli.js webhook-ping --account main --app 1234567890 --webhook WEBHOOK_ID
node dist/cli.js webhook-listen --port 8787
```

**API kataloğu:** `catalog/endpoints.json` Apple'ın OpenAPI 4.6 belgesinden üretilir (1.337 uç).
`api_catalog_search` arar; `api_read` katalogdaki GET uçlarını okur ve yazamaz. Güncellemek için Apple'ın
belgesini indirip `npm run catalog -- /absolute/path/openapi.oas.json` çalıştırın.

## İşlem sınırları

- Çok dilli güncelleme Apple tarafında atomik değildir; bazı adımlar başarılı, diğerleri başarısız olabilir.
  `completed` ve `needs_reconciliation` bu yüzden açıkça gösterilir. Otomatik geri alma yoktur.
- Ön kontrol ve PATCH arasında Apple arayüzünden başka biri değişiklik yapabilir. Apple tarafında
  koşullu yazma garantisi uygulanmıyor; mutlak bir yarış önleme garantisi verilmez.
- SQLite lease aynı veritabanını kullanan işlemleri hesap/uygulama bazında seri hale getirir.
  Çöken işlemden sonra lease en fazla beş dakikada boşa çıkar. Farklı veritabanları koordine edilmez.
- Metadata planları eski/yeni metinleri yerel diskte tutar; SQLite şifreli değildir.
- Salt okunur hesapta plan hazırlanabilir ama apply reddedilir.
- Koleksiyon cevaplarındaki `truncated` alanını kontrol edin; en fazla 2.000 kayıt istenir.
- İsteklerde 20 saniye timeout vardır. Sadece okumalar 429/5xx için sınırlı tekrar yapar.
  Yazmalar körlemesine tekrar edilmez. Redirect kapalıdır ve pagination hedefleri doğrulanır.
- Anahtar kelime sınırı UTF-8 bayt olarak muhafazakâr doğrulanır. Apple'ın ek içerik ve durum
  kuralları yine geçerlidir; plan oluşturmak inceleme kabulü anlamına gelmez.

## Test ve geliştirme

```sh
npm run check
npm test
npm run build
```

Testler geçici EC anahtarı, sahte Apple yanıtları ve geçici SQLite dosyaları kullanır.
Gerçek stdio MCP istemcisiyle araç keşfi, şema reddi ve hata sonuçları ayrıca doğrulanır.
**Gerçek Apple hesabında uçtan uca okuma/yazma henüz doğrulanmadı.** Yeni istek gövdeleri Apple'ın 4.6
OpenAPI şemasına göre yazıldı; Apple'ın çalışma anındaki kuralları farklı olabilir. İlk gerçek kullanımda
salt okunur araçlarla başlayın ve deneme uygulamasında ilerleyin.

## Bilinen eksikler

- Custom Product Page, ürün sayfası optimizasyonu, in-app event ve retention yerleşimleri.
- Finans raporları.
- Keychain ile anahtar saklama; uzak veya sunucu tabanlı çok kullanıcılı erişim.

## Kaynaklar

- [Apple API](https://developer.apple.com/app-store-connect/api/)
- [Apple JWT](https://developer.apple.com/documentation/AppStoreConnectAPI/generating-tokens-for-api-requests)
- [Asset Library yönetimi](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-your-app-store-assets/)
- [Webhook bildirimleri](https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications)
- [Asset yükleme](https://developer.apple.com/documentation/appstoreconnectapi/uploading-assets-to-app-store-connect)
- [MCP SDK 2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [Referans proje](https://github.com/tunaarikaya/magaza-mcp)
