# Portfolio Tracker

Amerikan borsalarındaki hisse ve fonlar için kişisel portföy takip uygulaması.

## Özellikler

- **İşlemler:** hisse alış/satış, nakit giriş/çıkış, temettü, faiz ve ücret. Düzenleme, silme (geri alınabilir), CSV içe/dışa aktarma.
- **Geçmiş:** ilk işlem gününden bugüne her işlem günü için portföy değeri, gerçek kapanış fiyatlarıyla yeniden hesaplanır. Uygulamanın açık olması gerekmez.
- **Grafikler:** portföy değeri ve yatırılan para, S&P 500 karşılaştırması, zirveden düşüş, günün ısı haritası, hisse/sektör dağılımı, kazancın kaynağı, aylık getiriler, hisse fiyatı üzerinde alış/satış noktaları. Her grafiğin tablo görünümü vardır.
- **Otomatik:** canlı fiyat, hisse bölünmesi düzeltmesi, kaydedilmemiş temettü önerileri.
- **Canlı:** veriler sayfa açıkken 60 saniyede bir yenilenir. Borsa kapalıyken fiyatlar değişmediği için hisse fiyatları 10 dakikada bir sorulur.
- **Makro göstergeler:** WTI petrol, ABD 2/10/30 yıllık faizler, dolar endeksi ve VIX. Kaynak CNBC'nin resmî olmayan servisi; WTI yaklaşık 10 dakika gecikmeli.
- **Mobil:** iPhone ve Android'e uygun düzen; ana ekrana eklenip uygulama gibi açılabilir.
- Açık/koyu tema, Türkçe arayüz.

## Çalıştırma

Node.js 22.13 veya üstü yeterlidir; kurulacak paket ve derleme adımı yoktur.

```
npm start
```

Ardından http://localhost:4517 adresini açın. Testler: `npm test`.

Veri `%LOCALAPPDATA%\PortfolioTracker\portfolio.db` dosyasında tutulur (macOS/Linux: `~/.local/share/PortfolioTracker`). Yerelde sunucu yalnızca bu bilgisayardan erişilebilir.

## Railway

`main` dalına gönderilen her değişiklik otomatik deploy edilir. Veritabanının korunması için servise bir Volume (ör. `/data`) bağlı olmalıdır.

Parola ilk açılışta uygulamanın içinde belirlenir. Bunun için sunucu loglarına yazılan tek kullanımlık kurulum kodu istenir; parola belirlenene kadar hiçbir veri gösterilmez.

| Değişken | Açıklama |
| --- | --- |
| `APP_PASSWORD` | İsteğe bağlı. Uygulamada belirlenen parolanın yerine geçer (unutulursa sıfırlamak için). |
| `PORT` | Varsayılan 4517 |
| `PORTFOLIO_DB` | Veritabanı yolunu değiştirir |

## Hesaplama yöntemi

- **Maliyet:** satışlarda FIFO; alış komisyonu maliyete eklenir, satış komisyonu gelirden düşülür.
- **Getiri (TWR):** para giriş çıkışından arındırılmış, zaman ağırlıklı. Girişler gün başında, çıkışlar gün sonunda sayılır.
- **XIRR:** para ağırlıklı yıllık getiri; portföy bir yılı doldurunca gösterilir.
- **S&P 500:** fiyat endeksi (temettüsüz).
- **Adet ve fiyat:** işlem günündeki gerçek değerler girilir; sonraki bölünmeler otomatik uygulanır.

Fiyatlar Yahoo Finance'in resmî olmayan servisinden gelir; gecikebilir veya kesilebilir. O durumda son bilinen fiyatlar gösterilir. Yatırım tavsiyesi değildir.
