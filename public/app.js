const $ = (selector) => document.querySelector(selector);
const recordButton = $("#recordButton");
const transcript = $("#transcript");
const statusBadge = $("#statusBadge");
const recorderVisual = $("#recorderVisual");
const timer = $("#timer");
const meterFill = $("#meterFill");
const levelText = $("#levelText");
const apiState = $("#apiState");

let stream;
let audioContext;
let processor;
let source;
let startedAt;
let timerInterval;
let isRecording = false;
let transcriptText = "";
let liveEntry = null;
let liveText = "";
let uploadQueue = Promise.resolve();

window.lucide?.createIcons();
setDate();
renderRecentNotes();
connectEvents();
checkConnection();

recordButton.addEventListener("click", () => isRecording ? stopRecording() : startRecording());
$("#settingsButton").addEventListener("click", () => $("#settingsDialog").showModal());
$("#retryButton").addEventListener("click", checkConnection);
$("#themeButton").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  $("#themeButton").innerHTML = document.body.classList.contains("dark") ? '<i data-lucide="moon"></i>' : '<i data-lucide="sun"></i>';
  window.lucide?.createIcons();
});
$("#copyButton").addEventListener("click", async () => {
  if (!transcriptText) return showToast("Henüz kopyalanacak not yok");
  await navigator.clipboard.writeText(transcriptText);
  showToast("Notlar panoya kopyalandı");
});
$("#downloadButton").addEventListener("click", downloadNotes);
document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName) && !$("#settingsDialog").open) {
    event.preventDefault();
    recordButton.click();
  }
});

function setDate() {
  const now = new Date();
  $("#dayName").textContent = new Intl.DateTimeFormat("tr-TR", { weekday: "long" }).format(now);
  $("#dayNumber").textContent = now.getDate();
  $("#monthName").textContent = new Intl.DateTimeFormat("tr-TR", { month: "long" }).format(now);
}

async function checkConnection() {
  $("#connectionTitle").textContent = "Bağlantı kontrol ediliyor";
  $("#connectionDetail").textContent = "Codex App Server aranıyor…";
  try {
    const response = await fetch("/api/status");
    const state = await response.json();
    updateConnection(state.configured, state.error);
  } catch {
    updateConnection(false, "Notely sunucusuna ulaşılamadı.");
  }
}

function updateConnection(connected, error) {
  apiState.textContent = connected ? "App Server bağlı" : "App Server bekleniyor";
  apiState.classList.toggle("ready", connected);
  $("#connectionTitle").textContent = connected ? "Codex hesabın bağlı" : "Bağlantı kurulamadı";
  $("#connectionDetail").textContent = connected ? "Canlı transkripsiyon kullanıma hazır." : (error || "Codex CLI oturumunu kontrol edin.");
}

function connectEvents() {
  const events = new EventSource("/api/realtime/events");
  events.addEventListener("thread/realtime/transcript/delta", (event) => {
    const payload = JSON.parse(event.data);
    applyDelta(payload.delta || payload.text || payload.transcript || "");
  });
  events.addEventListener("thread/realtime/transcript/done", (event) => {
    const payload = JSON.parse(event.data);
    finishTranscript(payload.transcript || payload.text || liveText);
  });
  events.addEventListener("app/status", (event) => updateConnection(JSON.parse(event.data).connected));
  events.addEventListener("app/error", (event) => {
    const payload = JSON.parse(event.data);
    updateConnection(false, payload.message);
    showToast(payload.message);
  });
  events.onerror = () => {
    apiState.textContent = "Bağlantı yenileniyor…";
    apiState.classList.remove("ready");
  };
}

async function startRecording() {
  try {
    const response = await fetch("/api/realtime/start", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    audioContext = new AudioContext({ sampleRate: 24000 });
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = ({ inputBuffer }) => {
      const samples = inputBuffer.getChannelData(0);
      const pcm = floatToPcm16(samples);
      updateMeter(samples);
      uploadQueue = uploadQueue.then(() => fetch("/api/realtime/audio", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Sample-Rate": String(audioContext.sampleRate), "X-Channels": "1" },
        body: pcm,
      })).catch(() => {});
    };
    source.connect(processor);
    processor.connect(audioContext.destination);
    isRecording = true;
    startedAt = Date.now();
    timerInterval = setInterval(updateTimer, 500);
    setRecordingUi(true);
  } catch (error) {
    showToast(error.name === "NotAllowedError" ? "Mikrofon izni verilmedi" : (error.message || "Canlı oturum başlatılamadı"));
    checkConnection();
  }
}

async function stopRecording() {
  isRecording = false;
  clearInterval(timerInterval);
  processor?.disconnect();
  source?.disconnect();
  stream?.getTracks().forEach((track) => track.stop());
  await audioContext?.close();
  await uploadQueue;
  await fetch("/api/realtime/stop", { method: "POST" }).catch(() => {});
  setRecordingUi(false);
  if (transcriptText) saveCurrentNote();
}

function floatToPcm16(samples) {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    output[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return output.buffer;
}

function updateMeter(samples) {
  let sum = 0;
  for (const value of samples) sum += value * value;
  const rms = Math.sqrt(sum / samples.length);
  const db = rms ? Math.max(-60, 20 * Math.log10(rms)) : -60;
  meterFill.style.width = `${Math.min(100, Math.max(2, (db + 60) * 1.67))}%`;
  levelText.textContent = rms ? `${Math.round(db)} dB` : "— dB";
}

function applyDelta(delta) {
  if (!delta) return;
  $("#emptyState")?.remove();
  if (!liveEntry) {
    liveEntry = createEntry(elapsedStamp(), "");
    liveEntry.classList.add("is-live");
    transcript.append(liveEntry);
  }
  liveText += delta;
  liveEntry.querySelector("p").textContent = liveText;
  transcript.scrollTop = transcript.scrollHeight;
}

function finishTranscript(finalText) {
  const text = String(finalText || "").trim();
  if (!text) return;
  if (!liveEntry) { liveEntry = createEntry(elapsedStamp(), text); transcript.append(liveEntry); }
  else liveEntry.querySelector("p").textContent = text;
  liveEntry.classList.remove("is-live");
  const stamp = liveEntry.querySelector("time").textContent;
  transcriptText += `${transcriptText ? "\n\n" : ""}[${stamp}] ${text}`;
  liveEntry = null;
  liveText = "";
  $("#wordCount").textContent = `${transcriptText.trim().split(/\s+/).length} kelime`;
}

function createEntry(stamp, text) {
  const entry = document.createElement("article");
  entry.className = "transcript-entry";
  const time = document.createElement("time");
  time.textContent = stamp;
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  entry.append(time, paragraph);
  return entry;
}

function elapsedStamp() {
  const seconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateTimer() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  timer.textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

function setRecordingUi(active) {
  statusBadge.classList.toggle("live", active);
  statusBadge.querySelector("b").textContent = active ? "Canlı" : "Tamamlandı";
  recorderVisual.classList.toggle("recording", active);
  recordButton.innerHTML = active ? '<i data-lucide="square"></i>' : '<i data-lucide="mic"></i>';
  recordButton.setAttribute("aria-label", active ? "Kaydı durdur" : "Kaydı başlat");
  $("#recordHint").textContent = active ? "Konuşma anlık olarak yazılıyor" : "Yeni kayıt için dokun";
  if (!active) { meterFill.style.width = "0"; levelText.textContent = "— dB"; }
  window.lucide?.createIcons();
}

function downloadNotes() {
  if (!transcriptText) return showToast("Henüz indirilecek not yok");
  const blob = new Blob([`${$("#lessonTitle").value}\n${new Date().toLocaleDateString("tr-TR")}\n\n${transcriptText}`], { type: "text/plain;charset=utf-8" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${$("#lessonTitle").value || "ders-notlari"}.txt` });
  link.click();
  URL.revokeObjectURL(link.href);
}

function saveCurrentNote() {
  const notes = JSON.parse(localStorage.getItem("notely-notes") || "[]");
  if (notes[0]?.text === transcriptText) return;
  notes.unshift({ title: $("#lessonTitle").value || "İsimsiz ders", text: transcriptText, date: new Date().toISOString() });
  localStorage.setItem("notely-notes", JSON.stringify(notes.slice(0, 10)));
  renderRecentNotes();
}

function renderRecentNotes() {
  const notes = JSON.parse(localStorage.getItem("notely-notes") || "[]");
  $("#noteBadge").textContent = notes.length;
  if (!notes.length) return;
  $("#recentList").replaceChildren(...notes.slice(0, 4).map((note) => {
    const button = document.createElement("button");
    button.className = "recent-item";
    button.innerHTML = "";
    const title = document.createElement("strong");
    title.textContent = note.title;
    const date = document.createElement("small");
    date.textContent = new Date(note.date).toLocaleDateString("tr-TR", { day: "numeric", month: "long" });
    button.append(title, date);
    button.addEventListener("click", () => loadNote(note));
    return button;
  }));
}

function loadNote(note) {
  $("#lessonTitle").value = note.title;
  transcriptText = note.text;
  transcript.replaceChildren();
  note.text.split("\n\n").forEach((line) => {
    const match = line.match(/^\[([^\]]+)\]\s*(.*)$/s);
    if (match) transcript.append(createEntry(match[1], match[2]));
  });
  $("#wordCount").textContent = `${note.text.trim().split(/\s+/).length} kelime`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("show"), 3000);
}
