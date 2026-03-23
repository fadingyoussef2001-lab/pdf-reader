/* ============================================================
   Andreh Deeb – PDF Reader with Live Text Highlighting
   ============================================================ */

'use strict';

// PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ---- State ---- */
const state = {
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1.5,
  textItems: [],       // flat list of {text, span} for current page
  wordIndex: 0,        // TTS progress index into textItems
  utterance: null,
  speaking: false,
  paused: false,
  detectedLang: null,  // detected language of the PDF
};

/* ---- DOM refs ---- */
const $ = id => document.getElementById(id);
const heroSection    = $('hero-section');
const readerSection  = $('reader-section');
const fileInput      = $('file-input');
const uploadZone     = $('upload-zone');
const btnChoose      = $('btn-choose');
const btnBack        = $('btn-back');
const btnPrev        = $('btn-prev');
const btnNext        = $('btn-next');
const pageInfo       = $('page-info');
const btnZoomIn      = $('btn-zoom-in');
const btnZoomOut     = $('btn-zoom-out');
const zoomLabel      = $('zoom-label');
const pdfCanvas      = $('pdf-canvas');
const textLayer      = $('text-layer');
const fileNameLabel  = $('file-name-label');
const langBadge      = $('lang-badge');
const btnPlay        = $('btn-play');
const iconPlay       = $('icon-play');
const iconPause      = $('icon-pause');
const ttsBtnLabel    = $('tts-btn-label');
const btnStop        = $('btn-stop');
const speedRange     = $('speed-range');
const speedValue     = $('speed-value');
const voiceSelect    = $('voice-select');
const readingProg    = $('reading-progress');

/* ============================================================
   Language Detection
   ============================================================ */
function detectLanguage(text) {
  if (!text || !text.trim()) return 'unknown';

  const arabicChars  = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars   = (text.match(/[A-Za-z]/g) || []).length;
  const germanChars  = (text.match(/[äöüÄÖÜß]/g) || []).length;
  const total        = arabicChars + latinChars;

  if (total === 0) return 'unknown';

  const arabicRatio  = arabicChars / total;

  if (arabicRatio > 0.4) return 'ar';
  if (germanChars > 5 && latinChars > arabicChars) return 'de';
  return 'en';
}

const LANG_LABELS = {
  ar:      'عربي',
  en:      'إنجليزي',
  de:      'ألماني',
  unknown: 'غير معروف',
};

const LANG_PREF = {
  ar: ['ar', 'arabic'],
  en: ['en-US', 'en-GB', 'en'],
  de: ['de-DE', 'de'],
};

function showLangBadge(lang) {
  langBadge.textContent = `اللغة: ${LANG_LABELS[lang] || lang}`;
  langBadge.classList.remove('hidden');
}

function applyLangToTextLayer(lang) {
  if (lang === 'ar') {
    textLayer.setAttribute('dir', 'rtl');
  } else {
    textLayer.setAttribute('dir', 'ltr');
  }
}

function autoSelectVoiceForLang(lang) {
  const voices = speechSynthesis.getVoices();
  const prefs  = LANG_PREF[lang] || [];
  for (const prefix of prefs) {
    const idx = voices.findIndex(v => v.lang.toLowerCase().startsWith(prefix.toLowerCase()));
    if (idx >= 0) { voiceSelect.value = idx; return; }
  }
}

/* ============================================================
   Upload / File Handling
   ============================================================ */
btnChoose.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) loadPDF(e.target.files[0]);
});

uploadZone.addEventListener('click', e => {
  if (e.target === btnChoose) return;
  fileInput.click();
});

uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') {
    loadPDF(file);
  } else {
    showToast('يرجى تحميل ملف PDF صالح.', true);
  }
});

async function loadPDF(file) {
  showLoading();
  stopTTS();

  const arrayBuffer = await file.arrayBuffer();
  try {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    state.pdfDoc     = pdf;
    state.totalPages = pdf.numPages;
    state.currentPage = 1;
    fileNameLabel.textContent = file.name;

    // Detect language from first page text
    const firstPage = await pdf.getPage(1);
    const firstContent = await firstPage.getTextContent();
    const sampleText = firstContent.items.map(i => i.str).join(' ');
    state.detectedLang = detectLanguage(sampleText);
    showLangBadge(state.detectedLang);
    applyLangToTextLayer(state.detectedLang);
    autoSelectVoiceForLang(state.detectedLang);

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
  clearHighlights();

  const page    = await state.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: state.scale });

  pdfCanvas.width  = viewport.width;
  pdfCanvas.height = viewport.height;

  const ctx = pdfCanvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Build text layer
  const textContent = await page.getTextContent();
  buildTextLayer(textContent, viewport);

  pageInfo.textContent = `صفحة ${pageNum} / ${state.totalPages}`;
  updateProgress();
  hideLoading();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function buildTextLayer(textContent, viewport) {
  textLayer.innerHTML = '';
  textLayer.style.width  = viewport.width  + 'px';
  textLayer.style.height = viewport.height + 'px';

  state.textItems = [];

  textContent.items.forEach(item => {
    if (!item.str.trim()) return;

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const x  = tx[4];
    const y  = tx[5] - item.height;
    const w  = item.width  * state.scale;
    const h  = item.height * state.scale;

    // Split into words for fine-grained highlighting
    const words = item.str.split(' ').filter(w => w.length > 0);
    const wordWidth = w / Math.max(words.length, 1);

    words.forEach((word, i) => {
      const span = document.createElement('span');
      span.textContent = word + ' ';
      span.style.left     = (x + i * wordWidth) + 'px';
      span.style.top      = y + 'px';
      span.style.width    = wordWidth + 'px';
      span.style.height   = h + 'px';
      span.style.fontSize = h + 'px';
      textLayer.appendChild(span);
      state.textItems.push({ text: word, span });
    });
  });

  // Re-apply direction for current page
  applyLangToTextLayer(state.detectedLang || 'ar');
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
  updateNav();
  updateProgress();
});

btnNext.addEventListener('click', async () => {
  if (state.currentPage >= state.totalPages) return;
  state.currentPage++;
  await renderPage(state.currentPage);
  updateNav();
  updateProgress();
});

function updateNav() {
  btnPrev.disabled = state.currentPage <= 1;
  btnNext.disabled = state.currentPage >= state.totalPages;
}

function updateProgress() {
  const pct = state.totalPages > 0
    ? (state.currentPage / state.totalPages) * 100
    : 0;
  readingProg.style.width = pct + '%';
}

/* ============================================================
   Zoom
   ============================================================ */
btnZoomIn.addEventListener('click', () => changeZoom(0.25));
btnZoomOut.addEventListener('click', () => changeZoom(-0.25));

async function changeZoom(delta) {
  const next = Math.min(Math.max(state.scale + delta, 0.5), 4);
  if (next === state.scale) return;
  state.scale = next;
  zoomLabel.textContent = Math.round(state.scale * 100) + '%';
  await renderPage(state.currentPage);
}

/* ============================================================
   Text-to-Speech with Word Highlighting
   ============================================================ */
function populateVoices() {
  const voices = speechSynthesis.getVoices();
  voiceSelect.innerHTML = '';
  voices.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  });
  // Prefer Arabic voice by default
  const arIdx = voices.findIndex(v => v.lang.startsWith('ar'));
  if (arIdx >= 0) voiceSelect.value = arIdx;
}

speechSynthesis.addEventListener('voiceschanged', populateVoices);
populateVoices();

speedRange.addEventListener('input', () => {
  speedValue.textContent = parseFloat(speedRange.value).toFixed(1) + '×';
  if (state.speaking && !state.paused) {
    restartTTSFromCurrent();
  }
});

btnPlay.addEventListener('click', () => {
  if (!state.pdfDoc) return;
  if (state.paused) {
    resumeTTS();
  } else if (state.speaking) {
    pauseTTS();
  } else {
    startTTS();
  }
});

btnStop.addEventListener('click', () => {
  stopTTS();
});

function startTTS() {
  if (!state.textItems.length) {
    showToast('لا يوجد نص في هذه الصفحة.');
    return;
  }
  state.wordIndex = 0;
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
  state.wordIndex = 0;
  clearHighlights();
  updatePlayButton();
  readingProg.style.width = (state.currentPage / Math.max(state.totalPages,1)) * 100 + '%';
}

function restartTTSFromCurrent() {
  const idx = state.wordIndex;
  speechSynthesis.cancel();
  setTimeout(() => speakFrom(idx), 80);
}

function speakFrom(startIdx) {
  if (startIdx >= state.textItems.length) {
    // Page done – auto advance
    state.speaking = false;
    updatePlayButton();
    if (state.currentPage < state.totalPages) {
      state.currentPage++;
      renderPage(state.currentPage).then(() => {
        updateNav();
        startTTS();
      });
    }
    return;
  }

  // Build text chunk of ~30 words for natural prosody
  const CHUNK = 30;
  const chunk  = state.textItems.slice(startIdx, startIdx + CHUNK);
  const text   = chunk.map(i => i.text).join(' ');

  const utt = new SpeechSynthesisUtterance(text);
  utt.rate  = parseFloat(speedRange.value);

  const LANG_CODE = { ar: 'ar-SA', en: 'en-US', de: 'de-DE' };
  utt.lang = LANG_CODE[state.detectedLang] || 'ar-SA';

  const voices = speechSynthesis.getVoices();
  const selIdx = parseInt(voiceSelect.value, 10);
  if (voices[selIdx]) utt.voice = voices[selIdx];

  // Word boundary highlighting
  utt.onboundary = e => {
    if (e.name !== 'word') return;
    const chunkText  = text.substring(0, e.charIndex);
    const wordsSoFar = chunkText.trim() ? chunkText.trim().split(/\s+/).length : 0;
    const globalIdx  = startIdx + wordsSoFar;
    highlightWord(globalIdx);
    state.wordIndex = globalIdx;
    const pct = (globalIdx / state.textItems.length) * 100;
    readingProg.style.width = pct + '%';
  };

  utt.onend = () => {
    if (!state.speaking) return;
    const nextIdx = startIdx + CHUNK;
    state.wordIndex = nextIdx;
    speakFrom(nextIdx);
  };

  utt.onerror = err => {
    if (err.error !== 'interrupted' && err.error !== 'canceled') {
      console.warn('TTS error:', err.error);
    }
  };

  state.utterance = utt;
  speechSynthesis.speak(utt);
}

function highlightWord(idx) {
  state.textItems.forEach((item, i) => {
    if (i < idx) {
      item.span.classList.remove('hl-active');
      item.span.classList.add('hl-done');
    } else if (i === idx) {
      item.span.classList.add('hl-active');
      item.span.classList.remove('hl-done');
      item.span.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      item.span.classList.remove('hl-active', 'hl-done');
    }
  });
}

function clearHighlights() {
  state.textItems.forEach(item => {
    item.span.classList.remove('hl-active', 'hl-done');
  });
}

function updatePlayButton() {
  if (state.speaking && !state.paused) {
    iconPlay.classList.add('hidden');
    iconPause.classList.remove('hidden');
    ttsBtnLabel.textContent = 'إيقاف مؤقت';
  } else if (state.paused) {
    iconPlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
    ttsBtnLabel.textContent = 'استمرار';
  } else {
    iconPlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
    ttsBtnLabel.textContent = 'بدء القراءة';
  }
}

/* ============================================================
   Loading overlay helpers (inline in viewer-wrapper)
   ============================================================ */
let spinnerEl = null;

function showLoading() {
  if (spinnerEl) return;
  spinnerEl = document.createElement('div');
  spinnerEl.className = 'spinner-wrap';
  spinnerEl.innerHTML = '<div class="spinner"></div><span>جارٍ تحميل الملف…</span>';
  document.querySelector('.viewer-wrapper')?.appendChild(spinnerEl);
  pdfCanvas.style.display = 'none';
  textLayer.style.display = 'none';
}

function hideLoading() {
  if (spinnerEl) { spinnerEl.remove(); spinnerEl = null; }
  pdfCanvas.style.display = '';
  textLayer.style.display = '';
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
   Keyboard shortcuts
   ============================================================ */
document.addEventListener('keydown', e => {
  if (!state.pdfDoc) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    if (state.currentPage < state.totalPages) {
      state.currentPage++;
      renderPage(state.currentPage).then(updateNav);
    }
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    if (state.currentPage > 1) {
      state.currentPage--;
      renderPage(state.currentPage).then(updateNav);
    }
  } else if (e.key === ' ') {
    e.preventDefault();
    btnPlay.click();
  } else if (e.key === 'Escape') {
    stopTTS();
  }
});
