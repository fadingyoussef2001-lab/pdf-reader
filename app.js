'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ============================================================
   الحالة
   ============================================================ */
const S = {
  pdf:       null,
  page:      1,
  pages:     0,
  scale:     1.5,
  items:     [],   // { text, x, y, w, h }
  sents:     [],   // { text, rects[] }
  idx:       0,
  playing:   false,
  paused:    false,
  textMode:  false,
};

/* ============================================================
   عناصر الصفحة
   ============================================================ */
const $  = id => document.getElementById(id);

const scrUpload  = $('screen-upload');
const scrReader  = $('screen-reader');
const dropZone   = $('drop-zone');
const fileInput  = $('file-input');
const btnChoose  = $('btn-choose');

const topbar     = $('topbar');
const btnBack    = $('btn-back');
const btnPrev    = $('btn-prev');
const btnNext    = $('btn-next');
const pageInfo   = $('page-info');
const btnZoomIn  = $('btn-zoom-in');
const btnZoomOut = $('btn-zoom-out');
const zoomLabel  = $('zoom-label');
const fileName   = $('file-name');
const btnMode    = $('btn-mode');

const btnPlay    = $('btn-play');
const btnStop    = $('btn-stop');
const speedRange = $('speed');
const speedVal   = $('speed-val');
const voiceSel   = $('voice-select');

const pdfView    = $('pdf-view');
const canvasWrap = $('canvas-wrap');
const pdfCanvas  = $('pdf-canvas');
const hlCanvas   = $('hl-canvas');
const hlCtx      = hlCanvas.getContext('2d');

const textView   = $('text-view');
const progFill   = $('progress-fill');

/* ============================================================
   رفع الملف
   ============================================================ */
btnChoose.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click',  e => { if (e.target !== btnChoose) fileInput.click(); });
fileInput.addEventListener('change', e => { if (e.target.files[0]) loadPDF(e.target.files[0]); });

dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f?.type === 'application/pdf') loadPDF(f);
});

async function loadPDF(file) {
  stopTTS();
  try {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    S.pdf   = pdf;
    S.pages = pdf.numPages;
    S.page  = 1;
    fileName.textContent = file.name;
    scrUpload.classList.add('hidden');
    scrReader.classList.remove('hidden');
    await renderPage(1);
    updateNav();
    pickArabicVoice();
  } catch {
    alert('خطأ في تحميل الملف. يرجى اختيار ملف PDF صالح.');
  }
}

/* ============================================================
   رسم الصفحة
   ============================================================ */
async function renderPage(num) {
  stopTTS();
  const page     = await S.pdf.getPage(num);
  const viewport = page.getViewport({ scale: S.scale });

  pdfCanvas.width  = hlCanvas.width  = viewport.width;
  pdfCanvas.height = hlCanvas.height = viewport.height;

  await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport }).promise;

  const tc = await page.getTextContent();
  buildItems(tc, viewport);

  pageInfo.textContent = `${num} / ${S.pages}`;
  progFill.style.width = (num / S.pages * 100) + '%';

  if (S.textMode) buildTextView();
  pdfView.scrollTop = 0;
  textView.scrollTop = 0;
}

/* ============================================================
   استخراج عناصر النص وبناء الجمل
   ============================================================ */
function buildItems(tc, viewport) {
  S.items = [];
  tc.items.forEach(item => {
    if (!item.str.trim()) return;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    S.items.push({
      text: item.str,
      x: tx[4],
      y: tx[5] - item.height,
      w: item.width,
      h: item.height,
    });
  });
  buildSents();
}

function buildSents() {
  S.sents = [];
  let cur = { parts: [], rects: [] };

  const flush = () => {
    if (!cur.parts.length) return;
    S.sents.push({ text: cur.parts.join(' ').trim(), rects: cur.rects });
    cur = { parts: [], rects: [] };
  };

  S.items.forEach(({ text, x, y, w, h }) => {
    cur.parts.push(text);
    cur.rects.push({ x, y, w, h });
    if (/[.!?؟،\n]/.test(text) || cur.parts.join(' ').length >= 120) flush();
  });
  flush();
}

/* ============================================================
   التمييز على الـ Canvas
   ============================================================ */
function drawHL(idx) {
  hlCtx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
  S.sents.forEach((s, i) => {
    if (i === idx) {
      hlCtx.fillStyle = 'rgba(200,168,75,0.45)';
      s.rects.forEach(r => {
        hlCtx.beginPath();
        hlCtx.roundRect(r.x - 2, r.y - 1, r.w + 4, r.h + 2, 3);
        hlCtx.fill();
      });
    } else if (i < idx) {
      hlCtx.fillStyle = 'rgba(200,168,75,0.15)';
      s.rects.forEach(r => hlCtx.fillRect(r.x, r.y, r.w, r.h));
    }
  });
}

function clearHL() {
  hlCtx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
}

/* ============================================================
   وضع النص الخالص
   ============================================================ */
function buildTextView() {
  textView.innerHTML = '';
  S.sents.forEach((s, i) => {
    const span = document.createElement('span');
    span.className = 'ts';
    span.dataset.i = i;
    span.textContent = s.text + ' ';
    span.addEventListener('click', () => {
      S.playing ? restartFrom(i) : startFrom(i);
    });
    textView.appendChild(span);
  });
}

function syncTextView(idx) {
  textView.querySelectorAll('.ts').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done',   i < idx && idx >= 0);
  });
  const active = textView.querySelector('.ts.active');
  if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ============================================================
   التبديل بين وضع PDF ووضع النص
   ============================================================ */
btnMode.addEventListener('click', () => {
  S.textMode = !S.textMode;
  btnMode.classList.toggle('active', S.textMode);
  btnMode.textContent = S.textMode ? '🖼 عرض PDF' : '📄 عرض النص';
  pdfView.classList.toggle('hidden', S.textMode);
  textView.classList.toggle('hidden', !S.textMode);
  if (S.textMode) buildTextView();
});

/* ============================================================
   التنقل بين الصفحات
   ============================================================ */
btnBack.addEventListener('click', () => {
  stopTTS();
  scrReader.classList.add('hidden');
  scrUpload.classList.remove('hidden');
  S.pdf = null;
  fileInput.value = '';
});

btnPrev.addEventListener('click', async () => {
  if (S.page <= 1) return;
  S.page--;
  await renderPage(S.page);
  updateNav();
});

btnNext.addEventListener('click', async () => {
  if (S.page >= S.pages) return;
  S.page++;
  await renderPage(S.page);
  updateNav();
});

function updateNav() {
  btnPrev.disabled = S.page <= 1;
  btnNext.disabled = S.page >= S.pages;
}

/* ============================================================
   التكبير والتصغير
   ============================================================ */
btnZoomIn.addEventListener('click',  () => zoom(0.25));
btnZoomOut.addEventListener('click', () => zoom(-0.25));

async function zoom(d) {
  const next = Math.min(Math.max(S.scale + d, 0.5), 4);
  if (next === S.scale) return;
  S.scale = next;
  zoomLabel.textContent = Math.round(S.scale * 100) + '%';
  await renderPage(S.page);
}

/* ============================================================
   الأصوات العربية
   ============================================================ */
function fillVoices() {
  const all = speechSynthesis.getVoices();
  voiceSel.innerHTML = '';
  const arabic = all.filter(v => v.lang.toLowerCase().startsWith('ar'));
  const list   = arabic.length ? arabic : all;   // احتياط إذا لم تتوفر أصوات عربية
  list.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = all.indexOf(v);
    o.textContent = `${v.name} (${v.lang})`;
    voiceSel.appendChild(o);
  });
}

function pickArabicVoice() {
  const all = speechSynthesis.getVoices();
  const idx = all.findIndex(v => v.lang.toLowerCase().startsWith('ar'));
  if (idx >= 0) voiceSel.value = idx;
}

speechSynthesis.addEventListener('voiceschanged', () => { fillVoices(); pickArabicVoice(); });
fillVoices();

speedRange.addEventListener('input', () => {
  speedVal.textContent = parseFloat(speedRange.value).toFixed(1) + '×';
  if (S.playing && !S.paused) restartFrom(S.idx);
});

/* ============================================================
   قراءة صوتية TTS
   ============================================================ */
btnPlay.addEventListener('click', () => {
  if (!S.pdf) return;
  if      (S.paused)  resume();
  else if (S.playing) pause();
  else                startFrom(0);
});

btnStop.addEventListener('click', stopTTS);

function startFrom(idx) {
  if (!S.sents.length) return;
  S.idx     = idx;
  S.playing = true;
  S.paused  = false;
  updateBtn();
  speakIdx(idx);
}

function pause() {
  speechSynthesis.pause();
  S.paused = true;
  updateBtn();
}

function resume() {
  speechSynthesis.resume();
  S.paused = false;
  updateBtn();
}

function stopTTS() {
  speechSynthesis.cancel();
  S.playing = false;
  S.paused  = false;
  S.idx     = 0;
  clearHL();
  syncTextView(-1);
  updateBtn();
}

function restartFrom(idx) {
  speechSynthesis.cancel();
  S.idx = idx;
  setTimeout(() => speakIdx(idx), 80);
}

function speakIdx(idx) {
  S.idx = idx;

  if (idx >= S.sents.length) {
    S.playing = false;
    updateBtn();
    clearHL();
    // انتقل للصفحة التالية تلقائياً
    if (S.page < S.pages) {
      S.page++;
      renderPage(S.page).then(() => { updateNav(); startFrom(0); });
    }
    return;
  }

  drawHL(idx);
  if (S.textMode) syncTextView(idx);

  // تمرير الصفحة لتظهر الجملة النشطة
  const r = S.sents[idx].rects[0];
  if (r && !S.textMode) {
    pdfView.scrollTo({ top: canvasWrap.offsetTop + r.y - pdfView.clientHeight / 3, behavior: 'smooth' });
  }

  progFill.style.width = ((S.page - 1 + idx / S.sents.length) / S.pages * 100) + '%';

  const utt  = new SpeechSynthesisUtterance(S.sents[idx].text);
  utt.lang   = 'ar-SA';
  utt.rate   = parseFloat(speedRange.value);

  const allVoices = speechSynthesis.getVoices();
  const vi = parseInt(voiceSel.value, 10);
  if (allVoices[vi]) utt.voice = allVoices[vi];

  utt.onend  = () => { if (S.playing) speakIdx(idx + 1); };
  utt.onerror = e => { if (e.error !== 'interrupted' && e.error !== 'canceled') console.warn(e.error); };

  speechSynthesis.speak(utt);
}

function updateBtn() {
  if (S.playing && !S.paused) {
    btnPlay.textContent = '⏸ إيقاف مؤقت';
  } else if (S.paused) {
    btnPlay.textContent = '▶ استمرار';
  } else {
    btnPlay.textContent = '▶ ابدأ القراءة';
  }
}

/* ============================================================
   اختصارات لوحة المفاتيح
   ============================================================ */
document.addEventListener('keydown', e => {
  if (!S.pdf) return;
  if (e.key === ' ')         { e.preventDefault(); btnPlay.click(); }
  else if (e.key === 'Escape') stopTTS();
  else if (e.key === 'ArrowLeft'  && S.page < S.pages) { S.page++; renderPage(S.page).then(updateNav); }
  else if (e.key === 'ArrowRight' && S.page > 1)        { S.page--; renderPage(S.page).then(updateNav); }
});
