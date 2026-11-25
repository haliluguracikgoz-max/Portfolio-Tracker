# Portfolio Tracker

Amerikan borsalarındaki hisse ve fonlar için kişisel portföy takip uygulaması.

## Özellikler

- **İşlemler:** hisse alış/satış, nakit giriş/çıkış, temettü, faiz ve ücret. Düzenleme, silme (geri alınabilir), CSV içe/dışa aktarma.
- **Geçmiş:** ilk işlem gününden bugüne her işlem günü için portföy değeri, gerçek kapanış fiyatlarıyla yeniden hesaplanır. Uygulamanın açık olması gerekmez.
- **Grafikler:** portföy değeri ve yatırılan para, S&P 500 karşılaştırması, zirveden düşüş, günün ısı haritası, hisse/sektör dağılımı, kazancın kaynağı, aylık getiriler, hisse fiyatı üzerinde alış/satış noktaları. Her grafiğin tablo görünümü vardır.
- **Otomatik:** canlı fiyat, hisse bölünmesi düzeltmesi, kaydedilmemiş temettü önerileri.
- Açık/koyu tema, mobil uyum, Türkçe arayüz.

## Çalıştırma

Node.js 22.13 veya üstü yeterlidir; kurulacak paket ve derleme adımı yoktur.

```
npm start
```

Ardından http://localhost:4517 adresini açın. Testler: `npm test`.

Veri `%LOCALAPPDATA%\PortfolioTracker\portfolio.db` dosyasında tutulur (macOS/Linux: `~/.local/share/PortfolioTracker`). Yerelde sunucu yalnızca bu bilgisayardan erişilebilir.

## Railway

`main` dalına gönderilen her değişiklik otomatik deploy edilir. Serviste iki şey zorunludur; eksikse uygulama hiçbir veri göstermez:

| Gereken | Neden |
| --- | --- |
| `APP_PASSWORD` değişkeni (en az 10 karakter) | Adres internete açıktır |
| Volume (ör. `/data`) | Veritabanı deploy'lar arasında korunur |

| Değişken | Açıklama |
| --- | --- |
| `APP_PASSWORD` | Giriş parolası. Yerelde isteğe bağlıdır. Değişince tüm oturumlar kapanır. |
| `PORT` | Varsayılan 4517 |
| `PORTFOLIO_DB` | Veritabanı yolunu değiştirir |

## Hesaplama yöntemi

- **Maliyet:** satışlarda FIFO; alış komisyonu maliyete eklenir, satış komisyonu gelirden düşülür.
- **Getiri (TWR):** para giriş çıkışından arındırılmış, zaman ağırlıklı. Girişler gün başında, çıkışlar gün sonunda sayılır.
- **XIRR:** para ağırlıklı yıllık getiri; portföy bir yılı doldurunca gösterilir.
- **S&P 500:** fiyat endeksi (temettüsüz).
- **Adet ve fiyat:** işlem günündeki gerçek değerler girilir; sonraki bölünmeler otomatik uygulanır.

Fiyatlar Yahoo Finance'in resmî olmayan servisinden gelir; gecikebilir veya kesilebilir. O durumda son bilinen fiyatlar gösterilir. Yatırım tavsiyesi değildir.
