/* ============================================================
   Andreh Deeb – PDF Reader with Canvas Highlight Overlay
   ============================================================ */

'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ---- State ---- */
const state = {
  pdfDoc:       null,
  currentPage:  1,
  totalPages:   0,
  scale:        1.5,
  textItems:    [],   // [{text, rect:{x,y,w,h}}]
  sentences:    [],   // [{text, rects:[{x,y,w,h}]}]
  sentIndex:    0,
  speaking:     false,
  paused:       false,
  detectedLang: null,
};

/* ---- DOM refs ---- */
const $ = id => document.getElementById(id);
const heroSection   = $('hero-section');
const readerSection = $('reader-section');
const fileInput     = $('file-input');
const uploadZone    = $('upload-zone');
const btnChoose     = $('btn-choose');
const btnBack       = $('btn-back');
const btnPrev       = $('btn-prev');
const btnNext       = $('btn-next');
const pageInfo      = $('page-info');
const btnZoomIn     = $('btn-zoom-in');
const btnZoomOut    = $('btn-zoom-out');
const zoomLabel     = $('zoom-label');
const pdfCanvas     = $('pdf-canvas');
const hlCanvas      = $('highlight-canvas');
const hlCtx         = hlCanvas.getContext('2d');
const fileNameLabel = $('file-name-label');
const langBadge     = $('lang-badge');
const btnPlay       = $('btn-play');
const iconPlay      = $('icon-play');
const iconPause     = $('icon-pause');
const ttsBtnLabel   = $('tts-btn-label');
const btnStop       = $('btn-stop');
const speedRange    = $('speed-range');
const speedValue    = $('speed-value');
const voiceSelect   = $('voice-select');
const readingProg   = $('reading-progress');

/* ============================================================
   Language Detection
   ============================================================ */
function detectLanguage(text) {
  if (!text || !text.trim()) return 'unknown';
  const arabic  = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latin   = (text.match(/[A-Za-z]/g)        || []).length;
  const german  = (text.match(/[äöüÄÖÜß]/g)       || []).length;
  const total   = arabic + latin;
  if (total === 0) return 'unknown';
  if (arabic / total > 0.4) return 'ar';
  if (german > 5 && latin > arabic) return 'de';
  return 'en';
}

const LANG_LABELS = { ar: 'عربي', en: 'إنجليزي', de: 'ألماني', unknown: 'غير معروف' };
const LANG_PREF   = { ar: ['ar', 'arabic'], en: ['en-US', 'en-GB', 'en'], de: ['de-DE', 'de'] };
const LANG_CODE   = { ar: 'ar-SA', en: 'en-US', de: 'de-DE' };

function showLangBadge(lang) {
  langBadge.textContent = `اللغة: ${LANG_LABELS[lang] || lang}`;
  langBadge.classList.remove('hidden');
}

function autoSelectVoice(lang) {
  const voices = speechSynthesis.getVoices();
  const prefs  = LANG_PREF[lang] || [];
  for (const p of prefs) {
    const idx = voices.findIndex(v => v.lang.toLowerCase().startsWith(p.toLowerCase()));
    if (idx >= 0) { voiceSelect.value = idx; return; }
  }
}

/* ============================================================
   Upload / File Handling
   ============================================================ */
btnChoose.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { if (e.target.files[0]) loadPDF(e.target.files[0]); });

uploadZone.addEventListener('click', e => { if (e.target !== btnChoose) fileInput.click(); });
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') loadPDF(file);
  else showToast('يرجى تحميل ملف PDF صالح.', true);
});

async function loadPDF(file) {
  showLoading();
  stopTTS();
  try {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    state.pdfDoc       = pdf;
    state.totalPages   = pdf.numPages;
    state.currentPage  = 1;
    fileNameLabel.textContent = file.name;

    const firstPage    = await pdf.getPage(1);
    const firstContent = await firstPage.getTextContent();
    const sample       = firstContent.items.map(i => i.str).join(' ');
    state.detectedLang = detectLanguage(sample);
    showLangBadge(state.detectedLang);
    autoSelectVoice(state.detectedLang);

    heroSection.classList.add('hidden');
    readerSection.classList.remove('hidden');
    await renderPage(state.currentPage);
    updateNav();
  } catch (err) {
    console.error(err);
    showToast('خطأ في تحميل الملف. يرجى اختيار ملف PDF صالح.', true);
    hideLoading();
  }
}

/* ============================================================
   PDF Rendering
   ============================================================ */
async function renderPage(pageNum) {
  showLoading();
  stopTTS();

  const page     = await state.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: state.scale });

  // Size both canvases identically
  pdfCanvas.width  = hlCanvas.width  = viewport.width;
  pdfCanvas.height = hlCanvas.height = viewport.height;

  // Render PDF onto pdfCanvas
  await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport }).promise;

  // Build text item rects (for highlight drawing)
  const textContent = await page.getTextContent();
  buildTextRects(textContent, viewport);

  pageInfo.textContent = `صفحة ${pageNum} / ${state.totalPages}`;
  updateProgress();
  hideLoading();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================
   Text Item Extraction – store bounding rects, no DOM spans
   ============================================================ */
function buildTextRects(textContent, viewport) {
  state.textItems = [];

  textContent.items.forEach(item => {
    if (!item.str.trim()) return;

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    // tx[4]=x (left edge), tx[5]=y (baseline)
    // item.height is in user-space; after transform it's already scaled
    const x = tx[4];
    const y = tx[5] - item.height;
    const w = item.width;    // width from PDF.js already in viewport space
    const h = item.height;

    state.textItems.push({ text: item.str, rect: { x, y, w, h } });
  });

  buildSentences();
}

/* ============================================================
   Sentence Builder – group text items into natural sentences
   (max ~120 chars so TTS doesn't get cut off)
   ============================================================ */
const MAX_SENT_CHARS = 120;

function buildSentences() {
  state.sentences = [];
  let cur = { parts: [], rects: [] };

  const flush = () => {
    if (cur.parts.length) {
      state.sentences.push({ text: cur.parts.join(' ').trim(), rects: cur.rects });
      cur = { parts: [], rects: [] };
    }
  };

  state.textItems.forEach(({ text, rect }) => {
    cur.parts.push(text);
    cur.rects.push(rect);
    const joined = cur.parts.join(' ');
    // Flush on sentence-ending punctuation OR when getting too long
    if (/[.!?؟،]/.test(text) || joined.length >= MAX_SENT_CHARS) {
      flush();
    }
  });
  flush();
}

/* ============================================================
   Canvas Highlight Drawing
   ============================================================ */
const HL_ACTIVE = 'rgba(108,99,255,0.50)';
const HL_DONE   = 'rgba(62,207,207,0.22)';

function clearHighlights() {
  hlCtx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
}

function drawHighlights(activeSentIdx) {
  clearHighlights();

  state.sentences.forEach((sent, i) => {
    if (i === activeSentIdx) {
      hlCtx.fillStyle = HL_ACTIVE;
      sent.rects.forEach(r => {
        hlCtx.beginPath();
        hlCtx.roundRect(r.x - 2, r.y - 1, r.w + 4, r.h + 2, 3);
        hlCtx.fill();
      });
    } else if (i < activeSentIdx) {
      hlCtx.fillStyle = HL_DONE;
      sent.rects.forEach(r => hlCtx.fillRect(r.x, r.y, r.w, r.h));
    }
  });
}

function scrollToSentence(sentIdx) {
  const sent = state.sentences[sentIdx];
  if (!sent || !sent.rects.length) return;
  const wrapper = document.querySelector('.viewer-wrapper');
  if (!wrapper) return;
  const r = sent.rects[0];
  // hlCanvas offset inside wrapper
  const canvasTop = hlCanvas.offsetTop;
  // Scroll so the sentence is roughly centered
  wrapper.scrollTo({ top: canvasTop + r.y - wrapper.clientHeight / 3, behavior: 'smooth' });
}

/* ============================================================
   Navigation
   ============================================================ */
btnBack.addEventListener('click', () => {
  stopTTS();
  heroSection.classList.remove('hidden');
  readerSection.classList.add('hidden');
  fileInput.value = '';
  state.pdfDoc = null;
  state.detectedLang = null;
  langBadge.classList.add('hidden');
});

btnPrev.addEventListener('click', async () => {
  if (state.currentPage <= 1) return;
  state.currentPage--;
  await renderPage(state.currentPage);
  updateNav(); updateProgress();
});

btnNext.addEventListener('click', async () => {
  if (state.currentPage >= state.totalPages) return;
  state.currentPage++;
  await renderPage(state.currentPage);
  updateNav(); updateProgress();
});

function updateNav() {
  btnPrev.disabled = state.currentPage <= 1;
  btnNext.disabled = state.currentPage >= state.totalPages;
}

function updateProgress() {
  const pct = state.totalPages > 0 ? (state.currentPage / state.totalPages) * 100 : 0;
  readingProg.style.width = pct + '%';
}

/* ============================================================
   Zoom
   ============================================================ */
btnZoomIn.addEventListener('click',  () => changeZoom( 0.25));
btnZoomOut.addEventListener('click', () => changeZoom(-0.25));

async function changeZoom(delta) {
  const next = Math.min(Math.max(state.scale + delta, 0.5), 4);
  if (next === state.scale) return;
  state.scale = next;
  zoomLabel.textContent = Math.round(state.scale * 100) + '%';
  await renderPage(state.currentPage);
}

/* ============================================================
   Voices
   ============================================================ */
function populateVoices() {
  const voices = speechSynthesis.getVoices();
  voiceSelect.innerHTML = '';
  voices.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value       = i;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  });
  autoSelectVoice(state.detectedLang || 'ar');
}

speechSynthesis.addEventListener('voiceschanged', populateVoices);
populateVoices();

speedRange.addEventListener('input', () => {
  speedValue.textContent = parseFloat(speedRange.value).toFixed(1) + '×';
  if (state.speaking && !state.paused) restartTTSFromCurrent();
});

/* ============================================================
   TTS
   ============================================================ */
btnPlay.addEventListener('click', () => {
  if (!state.pdfDoc) return;
  if      (state.paused)  resumeTTS();
  else if (state.speaking) pauseTTS();
  else                    startTTS();
});

btnStop.addEventListener('click', stopTTS);

function startTTS() {
  if (!state.sentences.length) { showToast('لا يوجد نص في هذه الصفحة.'); return; }
  state.sentIndex = 0;
  state.speaking  = true;
  state.paused    = false;
  updatePlayButton();
  speakFrom(0);
}

function pauseTTS() {
  speechSynthesis.pause();
  state.paused = true;
  updatePlayButton();
}

function resumeTTS() {
  speechSynthesis.resume();
  state.paused = false;
  updatePlayButton();
}

function stopTTS() {
  speechSynthesis.cancel();
  state.speaking  = false;
  state.paused    = false;
  state.sentIndex = 0;
  clearHighlights();
  updatePlayButton();
  updateProgress();
}

function restartTTSFromCurrent() {
  const idx = state.sentIndex;
  speechSynthesis.cancel();
  setTimeout(() => speakFrom(idx), 80);
}

function speakFrom(idx) {
  state.sentIndex = idx;

  if (idx >= state.sentences.length) {
    state.speaking = false;
    updatePlayButton();
    clearHighlights();
    // Auto-advance to next page
    if (state.currentPage < state.totalPages) {
      state.currentPage++;
      renderPage(state.currentPage).then(() => { updateNav(); startTTS(); });
    }
    return;
  }

  const sent = state.sentences[idx];
  drawHighlights(idx);
  scrollToSentence(idx);

  const pct = (idx / state.sentences.length) * 100;
  readingProg.style.width = pct + '%';

  const utt  = new SpeechSynthesisUtterance(sent.text);
  utt.rate   = parseFloat(speedRange.value);
  utt.lang   = LANG_CODE[state.detectedLang] || 'ar-SA';

  const voices = speechSynthesis.getVoices();
  const selIdx = parseInt(voiceSelect.value, 10);
  if (voices[selIdx]) utt.voice = voices[selIdx];

  utt.onend = () => {
    if (!state.speaking) return;
    speakFrom(idx + 1);
  };

  utt.onerror = err => {
    if (err.error !== 'interrupted' && err.error !== 'canceled')
      console.warn('TTS error:', err.error);
  };

  speechSynthesis.speak(utt);
}

function updatePlayButton() {
  const playing = state.speaking && !state.paused;
  iconPlay.classList.toggle('hidden',  playing);
  iconPause.classList.toggle('hidden', !playing);
  ttsBtnLabel.textContent = playing ? 'إيقاف مؤقت' : state.paused ? 'استمرار' : 'بدء القراءة';
}

/* ============================================================
   Loading Spinner
   ============================================================ */
let spinnerEl = null;

function showLoading() {
  if (spinnerEl) return;
  spinnerEl = document.createElement('div');
  spinnerEl.className = 'spinner-wrap';
  spinnerEl.innerHTML = '<div class="spinner"></div><span>جارٍ تحميل الملف…</span>';
  document.querySelector('.viewer-wrapper')?.appendChild(spinnerEl);
  pdfCanvas.style.display = hlCanvas.style.display = 'none';
}

function hideLoading() {
  if (spinnerEl) { spinnerEl.remove(); spinnerEl = null; }
  pdfCanvas.style.display = hlCanvas.style.display = '';
}

/* ============================================================
   Toast
   ============================================================ */
function showToast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

/* ============================================================
   Keyboard Shortcuts
   ============================================================ */
document.addEventListener('keydown', e => {
  if (!state.pdfDoc) return;
  if      (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    if (state.currentPage < state.totalPages) { state.currentPage++; renderPage(state.currentPage).then(updateNav); }
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    if (state.currentPage > 1)               { state.currentPage--; renderPage(state.currentPage).then(updateNav); }
  } else if (e.key === ' ')   { e.preventDefault(); btnPlay.click(); }
  else if (e.key === 'Escape') stopTTS();
});
