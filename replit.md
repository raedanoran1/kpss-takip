# KPSS Çalışma Ortamı Takibi — Web Uygulaması

## Proje Hakkında
Bu proje, başlangıçta Chrome tarayıcı eklentisi (Manifest V3) olarak geliştirilen KPSS çalışma takip uygulamasının iPad/iOS ve tüm mobil cihazlarda çalışan **Progressive Web App (PWA)** versiyonudur.

## Özellikler
- Bugün sekmesi: günlük çalışma planı
- Konular: konu takibi ve ilerleme
- Sorular: fotoğraflı soru bankası (tekrar sistemi - SRS)
- Notlar: çalışma notları ve tekrar
- Deneme: puan hesaplama ve geçmiş
- Çalışma İstatistiği: günlük/haftalık çalışma istatistikleri
- Kaynaklar: kaynak kitap/PDF takibi
- Ses Kütüphanesi: ders kayıtları
- Alışkanlıklar: günlük alışkanlık takibi
- Cevşen: sesli Cevşen okuma
- Yasin: Yasin Suresi okuma
- Hızlı Okuma: hız okuma egzersizi
- Yedek: JSON formatında tam yedek/geri yükleme
- Çizim: üzerine çizim yapma aracı

## Teknik Yapı

### Dönüşüm
- Chrome Extension API'leri (`chrome.storage.local`, `chrome.runtime.getURL` vb.) → `js/chrome-polyfill.js` ile IndexedDB tabanlı web standardlarına dönüştürüldü
- Ses kayıt sistemi (offscreen document) → doğrudan MediaRecorder API'ye dönüştürüldü
- PWA manifest (`pwa-manifest.json`) ve Service Worker (`sw.js`) eklendi
- Express sunucu (`server.js`) ile statik dosyalar sunuluyor

### Dosya Yapısı
```
index.html              # Ana sayfa (PWA uyumlu, polyfill ile)
pwa-manifest.json       # PWA manifest (kurulum için)
sw.js                   # Service Worker (offline destek)
server.js               # Express sunucu
js/
  chrome-polyfill.js    # Chrome Extension API'lerinin IndexedDB tabanlı yedeği
  sidepanel.js          # Ana uygulama mantığı
  db.js                 # SQLite veritabanı (sql.js)
  managers/             # Modül yöneticileri
  state/                # Uygulama durumu
  utils/                # Yardımcı fonksiyonlar
css/                    # Stiller
lib/                    # sql-wasm, pdf.js kütüphaneleri
web_resources/          # Ses dosyaları (Cevşen MP3'leri)
```

### Depolama
- SQLite veritabanı (sql.js) → IndexedDB'de saklanıyor
- Resimler, ses kayıtları → IndexedDB'de saklanıyor
- Uygulama durumu → IndexedDB'de saklanıyor

## Çalıştırma
```bash
node server.js
```
Port: 5000

## PDF Görüntüleyici Özellikleri

### Sol Bar (Dikey Araç Çubuğu)
- **Sürüklenebilir**: Üstteki tutma noktasından (⠿) tutarak ekranda serbestçe taşınabilir (hem yatay hem dikey)
- **Konum hafızası**: Son konum localStorage'a kaydedilir, PDF açılıp kapansa bile hatırlanır
- **Varsayılan konum**: Dikey ortada, sol kenara hizalı
- **G (Gemini) butonu**: En üstte, Gemini popup'ını açar/kapatır
- **Araç toggle**: ▼ butonu ile not ekleme, soru ekleme, soru yapıştır ve optik form butonları açılıp kapanır (varsayılan kapalı)

### Gemini Popup
- **Lazy loading**: Gemini iframe sayfa yüklendiğinde DEĞİL, G butonu veya Gemini toggle ile açıldığında yüklenir
- **Eklenti ile aynı davranış**: eklenti/js/managers/pdf-viewer-manager.js ile bire bir parity
- **Sürüklenebilir ve yeniden boyutlandırılabilir popup**

### İkincil PDF Görüntüleyici
- Zoom kontrolü: +/- butonlar yerine doğrudan değer girilen input alanı (%30-%400 arası)

## iPad'e Kurulum (PWA)
1. Safari'de uygulamayı aç
2. "Paylaş" butonuna tıkla (kutu + ok ikonu)
3. "Ana Ekrana Ekle"yi seç
4. Uygulama artık ana ekranda görünür ve tam ekran çalışır
