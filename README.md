# Notely — Canlı Ders Transkripsiyonu

Mikrofon sesini Codex App Server'a gerçek zamanlı olarak aktaran ve `thread/realtime/transcript/delta` olaylarını konuşma devam ederken canlı ders notlarına dönüştüren masaüstü deneyimi.

## Kurulum

Node.js 20+, Codex CLI ve aktif bir Codex/ChatGPT oturumu gerekir. Bir kez `codex login` ile giriş yaptıktan sonra:

```bash
npm start
```

Bu kadar. Notely `codex app-server` sürecini ve tarayıcıyı otomatik açar. API anahtarı girmeniz, `.env` oluşturmanız veya ayrı API bakiyesi tanımlamanız gerekmez; mevcut Codex oturumunuz kullanılır.

Tarayıcı otomatik açılmazsa `http://localhost:3000` adresini açabilirsiniz.

> Notely bir OpenAI API entegrasyonu değildir. Yerel Codex App Server'ın JSON-RPC protokolünü kullanır.

## Özellikler

- Konuşma bitmeden kelime kelime akan delta transkripsiyonu
- `thread/realtime/transcript/delta` ve `thread/realtime/transcript/done` desteği
- Türkçe ve teknik ders terimleri için yönlendirme
- Mikrofon seviye göstergesi ve kayıt sayacı
- Notları panoya kopyalama veya `.txt` olarak indirme
- Aydınlık/karanlık tema ve mobil uyumlu arayüz
- API anahtarsız, mevcut Codex oturumuyla çalışma
- App Server'ı otomatik başlatan yerel köprü
- Son dersleri cihazda saklayan yerel ders arşivi
- Tek komutla başlatma ve tarayıcıyı otomatik açma
