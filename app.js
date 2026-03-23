'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ═══════════════════════════════════════════════════════
   الحالة الكاملة
   ═══════════════════════════════════════════════════════ */
const APP = {
  pdf:      null,
  pages:    0,
  fontSize: 1.6,        // rem
  words:    [],         // كل كلمات الكتاب: { text, sentIdx, wordIdx, el }
  sents:    [],         // كل الجمل:        { words:[], el }
  wIdx:     0,          // الكلمة النشطة الحالية
  playing:  false,
  paused:   false,
};

/* ═══════════════════════════════════════════════════════
   مراجع DOM
   ═══════════════════════════════════════════════════════ */
const $        = id => document.getElementById(id);
const pgUpload = $('page-upload');
const pgReader = $('page-reader');
const dropZone = $('drop-zone');
const fileInp  = $('file-input');
const errMsg   = $('upload-error');
const btnNew   = $('btn-new');
const lblFile  = $('lbl-file');
const btnPrev  = $('btn-prev');
const btnNext  = $('btn-next');
const lblPage  = $('lbl-page');
const btnPlay  = $('btn-play');
const btnStop  = $('btn-stop');
const rngSpeed = $('rng-speed');
const lblSpeed = $('lbl-speed');
const selVoice = $('sel-voice');
const btnFsUp  = $('btn-fs-up');
const btnFsDn  = $('btn-fs-down');
const txtArea  = $('text-area');
const txtCont  = $('text-content');
const progFill = $('prog-fill');

/* ═══════════════════════════════════════════════════════
   رفع الملف
   ═══════════════════════════════════════════════════════ */
dropZone.addEventListener('click', () => fileInp.click());
fileInp.addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) openFile(f); else showErr();
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f?.type === 'application/pdf') openFile(f); else showErr();
});

function showErr() {
  errMsg.classList.remove('hidden');
  setTimeout(() => errMsg.classList.add('hidden'), 3000);
}

/* ═══════════════════════════════════════════════════════
   تحميل PDF واستخراج كل النص
   ═══════════════════════════════════════════════════════ */
async function openFile(file) {
  stopTTS();
  APP.words = [];
  APP.sents = [];
  APP.wIdx  = 0;

  lblFile.textContent = file.name;
  pgUpload.classList.add('hidden');
  pgReader.classList.remove('hidden');

  showLoading();

  try {
    APP.pdf   = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    APP.pages = APP.pdf.numPages;
    lblPage.textContent = `1 / ${APP.pages}`;
    await extractAllText();
    renderText();
    updateNav();
    pickArabicVoice();
  } catch (err) {
    console.error(err);
    txtCont.innerHTML = '<p class="loading-msg" style="color:#c00">خطأ في قراءة الملف.</p>';
  }
}

/* ─── استخراج نص كل الصفحات ─── */
async function extractAllText() {
  const allLines = [];   // كل السطور من كل الصفحات

  for (let p = 1; p <= APP.pages; p++) {
    const page = await APP.pdf.getPage(p);
    const tc   = await page.getTextContent({ normalizeWhitespace: true });

    // نجمع عناصر النص مرتبة حسب موقعها (من أعلى إلى أسفل، يمين إلى يسار)
    const items = tc.items
      .filter(i => i.str.trim())
      .map(i => ({
        str: i.str.trim(),
        x:   i.transform[4],
        y:   i.transform[5],
      }));

    // نجمع العناصر التي على نفس السطر
    const lineMap = {};
    items.forEach(item => {
      const key = Math.round(item.y / 4) * 4;  // تقريب للسطر نفسه
      if (!lineMap[key]) lineMap[key] = [];
      lineMap[key].push(item);
    });

    // نرتب الأسطر من أعلى إلى أسفل (y كبير = أعلى في PDF)
    const sortedKeys = Object.keys(lineMap).map(Number).sort((a, b) => b - a);

    sortedKeys.forEach(key => {
      // داخل السطر: نرتب من اليمين إلى اليسار (x كبير = يمين)
      const line = lineMap[key].sort((a, b) => b.x - a.x);
      const text = line.map(i => i.str).join(' ').trim();
      if (text) allLines.push(text);
    });

    // فاصل بين الصفحات
    if (p < APP.pages) allLines.push(`\x00PAGE:${p + 1}\x00`);
  }

  // نبني الجمل من الأسطر
  buildSentences(allLines);
}

/* ─── تقسيم النص إلى جمل وكلمات ─── */
function buildSentences(lines) {
  APP.words = [];
  APP.sents = [];

  let cur = [];

  const flushSent = () => {
    if (!cur.length) return;
    const text = cur.join(' ').trim();
    if (text) APP.sents.push({ text, words: [] });
    cur = [];
  };

  lines.forEach(line => {
    if (line.startsWith('\x00PAGE:')) {
      flushSent();
      APP.sents.push({ pageBreak: parseInt(line.replace('\x00PAGE:', '').replace('\x00', '')) });
      return;
    }

    cur.push(line);

    // نفصّل عند نقاط التوقف العربية والإنجليزية
    if (/[.!?؟\n]/.test(line) || cur.join(' ').length > 200) {
      flushSent();
    }
  });
  flushSent();
}

/* ═══════════════════════════════════════════════════════
   بناء عناصر HTML للنص
   ═══════════════════════════════════════════════════════ */
function renderText() {
  txtCont.innerHTML = '';
  APP.words = [];
  let globalWIdx = 0;
  let currentPage = 1;

  APP.sents.forEach((sent, sIdx) => {
    if (sent.pageBreak) {
      currentPage = sent.pageBreak;
      const sep = document.createElement('div');
      sep.className = 'page-sep';
      sep.textContent = `صفحة ${currentPage}`;
      txtCont.appendChild(sep);
      return;
    }

    const sentEl = document.createElement('span');
    sentEl.className = 'sent';
    sentEl.dataset.s = sIdx;
    sent.el = sentEl;

    // نقسم الجملة إلى كلمات
    const words = sent.text.split(/\s+/).filter(Boolean);
    words.forEach((w, wInSent) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = w;
      span.dataset.w = globalWIdx;

      const wordObj = { text: w, sentIdx: sIdx, wInSent, globalIdx: globalWIdx, el: span };
      APP.words.push(wordObj);
      sent.words.push(wordObj);

      span.addEventListener('click', () => {
        if (APP.playing) restartFrom(globalWIdx);
        else startFrom(globalWIdx);
      });

      sentEl.appendChild(span);
      sentEl.appendChild(document.createTextNode(' '));
      globalWIdx++;
    });

    txtCont.appendChild(sentEl);
    txtCont.appendChild(document.createTextNode(' '));
  });

  txtCont.style.fontSize = APP.fontSize + 'rem';
}

/* ═══════════════════════════════════════════════════════
   تمييز الكلمة والجملة
   ═══════════════════════════════════════════════════════ */
let lastWordEl  = null;
let lastSentEl  = null;
let lastSentIdx = -1;

function highlightWord(wIdx) {
  // أزل التمييز السابق
  if (lastWordEl) lastWordEl.classList.remove('active');

  const word = APP.words[wIdx];
  if (!word) return;

  word.el.classList.add('active');
  lastWordEl = word.el;

  // تمييز الجملة
  if (word.sentIdx !== lastSentIdx) {
    if (lastSentEl) {
      lastSentEl.classList.remove('active');
      lastSentEl.classList.add('done');
    }
    const sent = APP.sents[word.sentIdx];
    if (sent?.el) {
      sent.el.classList.add('active');
      lastSentEl = sent.el;
    }
    lastSentIdx = word.sentIdx;
  }

  // تمرير تلقائي
  word.el.scrollIntoView({ block: 'center', behavior: 'smooth' });

  // تقدم الشريط
  progFill.style.width = (wIdx / Math.max(APP.words.length - 1, 1) * 100) + '%';
}

function clearHighlights() {
  if (lastWordEl)  lastWordEl.classList.remove('active');
  if (lastSentEl)  { lastSentEl.classList.remove('active'); lastSentEl.classList.remove('done'); }
  txtCont.querySelectorAll('.sent.done').forEach(el => el.classList.remove('done'));
  lastWordEl  = null;
  lastSentEl  = null;
  lastSentIdx = -1;
  progFill.style.width = '0%';
}

/* ═══════════════════════════════════════════════════════
   أصوات عربية
   ═══════════════════════════════════════════════════════ */
function fillVoices() {
  const all    = speechSynthesis.getVoices();
  const arabic = all.filter(v => v.lang.toLowerCase().startsWith('ar'));
  const list   = arabic.length ? arabic : all;
  selVoice.innerHTML = '';
  list.forEach(v => {
    const o     = document.createElement('option');
    o.value     = all.indexOf(v);
    o.textContent = `${v.name} (${v.lang})`;
    selVoice.appendChild(o);
  });
}

function pickArabicVoice() {
  const all = speechSynthesis.getVoices();
  const idx = all.findIndex(v => v.lang.toLowerCase().startsWith('ar'));
  if (idx >= 0) selVoice.value = idx;
}

speechSynthesis.addEventListener('voiceschanged', () => { fillVoices(); pickArabicVoice(); });
fillVoices();

rngSpeed.addEventListener('input', () => {
  lblSpeed.textContent = parseFloat(rngSpeed.value).toFixed(1) + '×';
  if (APP.playing && !APP.paused) restartFrom(APP.wIdx);
});

/* ═══════════════════════════════════════════════════════
   محرك TTS – يقرأ كلمة بكلمة
   ═══════════════════════════════════════════════════════ */
btnPlay.addEventListener('click', () => {
  if (!APP.pdf) return;
  if      (APP.paused)  resumeTTS();
  else if (APP.playing) pauseTTS();
  else                  startFrom(APP.wIdx);
});

btnStop.addEventListener('click', stopTTS);

function startFrom(wIdx) {
  if (!APP.words.length) return;
  APP.wIdx    = wIdx;
  APP.playing = true;
  APP.paused  = false;
  updateBtn();
  speakChunk(wIdx);
}

function pauseTTS() {
  speechSynthesis.pause();
  APP.paused = true;
  updateBtn();
}

function resumeTTS() {
  speechSynthesis.resume();
  APP.paused = false;
  updateBtn();
}

function stopTTS() {
  speechSynthesis.cancel();
  APP.playing = false;
  APP.paused  = false;
  APP.wIdx    = 0;
  clearHighlights();
  updateBtn();
}

function restartFrom(wIdx) {
  speechSynthesis.cancel();
  APP.wIdx = wIdx;
  setTimeout(() => speakChunk(wIdx), 60);
}

/*
  نقرأ جملة كاملة دفعة واحدة (أفضل للتدفق الصوتي العربي)
  لكن نتابع الكلمات يدويًا بـ onboundary
*/
function speakChunk(startWIdx) {
  APP.wIdx = startWIdx;
  if (startWIdx >= APP.words.length) {
    APP.playing = false;
    updateBtn();
    clearHighlights();
    return;
  }

  // نجمع الجملة التي تبدأ منها
  const firstWord = APP.words[startWIdx];
  const sIdx      = firstWord.sentIdx;

  // كل كلمات هذه الجملة اعتبارًا من startWIdx
  const sent       = APP.sents[sIdx];
  const sentWords  = sent?.words ?? [];
  const fromInSent = sentWords.findIndex(w => w.globalIdx >= startWIdx);
  const chunk      = sentWords.slice(fromInSent >= 0 ? fromInSent : 0);

  if (!chunk.length) { speakChunk(startWIdx + 1); return; }

  const text = chunk.map(w => w.text).join(' ');
  const utt  = new SpeechSynthesisUtterance(text);
  utt.lang   = 'ar-SA';
  utt.rate   = parseFloat(rngSpeed.value);

  const allVoices = speechSynthesis.getVoices();
  const vi        = parseInt(selVoice.value, 10);
  if (allVoices[vi]) utt.voice = allVoices[vi];

  // تتبع الكلمات عبر onboundary
  let chunkWordIdx = 0;
  utt.addEventListener('boundary', e => {
    if (e.name !== 'word') return;
    const wObj = chunk[chunkWordIdx];
    if (wObj) { highlightWord(wObj.globalIdx); APP.wIdx = wObj.globalIdx; }
    chunkWordIdx++;
  });

  utt.onend = () => {
    if (!APP.playing) return;
    const nextSentStart = sentWords[sentWords.length - 1]?.globalIdx + 1 ?? startWIdx + 1;
    speakChunk(nextSentStart);
  };

  utt.onerror = err => {
    if (err.error !== 'interrupted' && err.error !== 'canceled') console.warn('TTS:', err.error);
  };

  // تمييز أول كلمة فورًا
  highlightWord(chunk[0].globalIdx);
  speechSynthesis.speak(utt);
}

function updateBtn() {
  if (APP.playing && !APP.paused) btnPlay.textContent = '⏸ إيقاف مؤقت';
  else if (APP.paused)            btnPlay.textContent = '▶ استمرار';
  else                            btnPlay.textContent = '▶ ابدأ القراءة';
}

/* ═══════════════════════════════════════════════════════
   التنقل بين الصفحات (يحرك النص إلى فاصل الصفحة)
   ═══════════════════════════════════════════════════════ */
btnPrev.addEventListener('click', () => scrollToPageSep(-1));
btnNext.addEventListener('click', () => scrollToPageSep(+1));

function updateNav() {
  const seps = Array.from(txtCont.querySelectorAll('.page-sep'));
  btnPrev.disabled = seps.length === 0;
  btnNext.disabled = seps.length === 0;
}

function scrollToPageSep(dir) {
  const seps = Array.from(txtCont.querySelectorAll('.page-sep'));
  if (!seps.length) return;
  const areaTop = txtArea.scrollTop;
  if (dir > 0) {
    const next = seps.find(s => s.offsetTop > areaTop + 50);
    if (next) { txtArea.scrollTo({ top: next.offsetTop - 20, behavior: 'smooth' }); updatePageLabel(next); }
  } else {
    const prev = [...seps].reverse().find(s => s.offsetTop < areaTop - 50);
    if (prev) { txtArea.scrollTo({ top: prev.offsetTop - 20, behavior: 'smooth' }); updatePageLabel(prev); }
  }
}

function updatePageLabel(sepEl) {
  const m = sepEl.textContent.match(/\d+/);
  if (m) lblPage.textContent = `${m[0]} / ${APP.pages}`;
}

/* ═══════════════════════════════════════════════════════
   حجم الخط
   ═══════════════════════════════════════════════════════ */
btnFsUp.addEventListener('click', () => setFontSize(APP.fontSize + 0.15));
btnFsDn.addEventListener('click', () => setFontSize(APP.fontSize - 0.15));

function setFontSize(v) {
  APP.fontSize = Math.min(Math.max(v, 1.0), 3.0);
  txtCont.style.fontSize = APP.fontSize + 'rem';
}

/* ═══════════════════════════════════════════════════════
   ملف جديد
   ═══════════════════════════════════════════════════════ */
btnNew.addEventListener('click', () => {
  stopTTS();
  pgReader.classList.add('hidden');
  pgUpload.classList.remove('hidden');
  fileInp.value = '';
  txtCont.innerHTML = '';
  APP.pdf = null;
});

/* ═══════════════════════════════════════════════════════
   مساعد التحميل
   ═══════════════════════════════════════════════════════ */
function showLoading() {
  txtCont.innerHTML = `<div class="loading-msg"><div class="spinner"></div> جارٍ قراءة الملف…</div>`;
}

/* ═══════════════════════════════════════════════════════
   اختصارات لوحة المفاتيح
   ═══════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (!APP.pdf) return;
  if      (e.key === ' ')      { e.preventDefault(); btnPlay.click(); }
  else if (e.key === 'Escape') stopTTS();
  else if (e.key === 'ArrowLeft')  scrollToPageSep(+1);
  else if (e.key === 'ArrowRight') scrollToPageSep(-1);
});
