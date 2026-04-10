/* ملف المحرك البرمجي - تطبيق ليرة (يحيى قاضي) */

// 1. إعدادات الفيديو والافتتاحية
const introVideo = document.getElementById('introVideo');
const introOverlay = document.getElementById('introVideoOverlay');

// عند تحميل الصفحة، ابدأ الفيديو من الثانية الثالثة
window.addEventListener('load', () => {
    if (introVideo) {
        introVideo.currentTime = 3;
        introVideo.play().catch(() => console.log("بانتظار تفاعل المستخدم لتشغيل الفيديو"));
        introVideo.onended = () => hideIntro();
    }
});

// وظيفة إخفاء شاشة الافتتاح
function hideIntro() {
    if (introOverlay) {
        introOverlay.style.opacity = '0';
        setTimeout(() => introOverlay.style.display = 'none', 500);
    }
}

// 2. التحكم في القائمة والصفحات
let activeConvert = 'old';
let splitMode = 'NEW';

function toggleMenu() {
    document.getElementById('sideMenu').classList.toggle('active');
}

function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    toggleMenu();
}

// وظيفة دوران النسر عند الضغط
function handleEagleClick(id, callback) {
    document.getElementById(id).classList.toggle('rotate');
    callback();
}

// 3. محرك التفقيط (تحويل الأرقام إلى كلمات)
function numberToArabicWords(n) {
    if (n === 0) return "صفر";
    const units = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
    const tens = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
    const hundreds = ["", "مئة", "مئتان", "ثلاثمئة", "أربعمئة", "خمسمئة", "ستمئة", "سبعمئة", "ثمانمئة", "تسعمئة"];

    function convert(num) {
        if (num < 20) return units[num];
        if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 !== 0 ? " و" + units[num % 10] : "");
        if (num < 1000) return hundreds[Math.floor(num / 100)] + (num % 100 !== 0 ? " و" + convert(num % 100) : "");
        if (num < 1000000) {
            let thousands = Math.floor(num / 1000);
            let rem = num % 1000;
            let tStr = thousands === 1 ? "ألف" : thousands === 2 ? "ألفان" : (thousands <= 10 ? convert(thousands) + " آلاف" : convert(thousands) + " ألف");
            return tStr + (rem !== 0 ? " و" + convert(rem) : "");
        }
        if (num < 1000000000) {
            let millions = Math.floor(num / 1000000);
            let rem = num % 1000000;
            let mStr = millions === 1 ? "مليون" : millions === 2 ? "مليونان" : (millions <= 10 ? convert(millions) + " ملايين" : convert(millions) + " مليون");
            return mStr + (rem !== 0 ? " و" + convert(rem) : "");
        }
        return num.toLocaleString(); 
    }
    return convert(n) + " ليرة";
}

// تحديث الكلمات تحت الخانات
function updateWords(input, targetId) {
    let val = parseInt(input.value) || 0;
    document.getElementById(targetId).innerText = val > 0 ? "أي: " + numberToArabicWords(val) : "";
}

// 4. وظائف الحساب
function doQuick() {
    let o = document.getElementById('oldIn'), n = document.getElementById('newIn');
    if(activeConvert === 'old' && o.value) { 
        n.value = Math.floor(o.value/100); 
        updateWords(n, 'w2'); 
        document.getElementById('qRes').innerText = n.value + " ل.س جديد"; 
    }
    else if(n.value) { 
        o.value = n.value * 100; 
        updateWords(o, 'w1'); 
        document.getElementById('qRes').innerText = o.value + " ل.س قديم"; 
    }
}

function doUsd() {
    let r = parseFloat(document.getElementById('uRate').value) || 0;
    let a = parseFloat(document.getElementById('uAmt').value) || 0;
    document.getElementById('uRes').innerText = Math.floor(r * a).toLocaleString() + " ل.س جديد";
}

function setSplitMode(m) {
    splitMode = m;
    document.getElementById('mNew').className = m === 'NEW' ? 'mode-btn active' : 'mode-btn';
    document.getElementById('mOld').className = m === 'OLD' ? 'mode-btn active' : 'mode-btn';
}

function doSplit() {
    let total = parseFloat(document.getElementById('splitTotal').value) || 0;
    let ratio = document.getElementById('splitRange').value / 100;
    let share = Math.round(total * ratio);
    let rest = total - share;
    
    if(splitMode === 'NEW') {
        document.getElementById('sPay').innerText = "حصتك: " + share.toLocaleString() + " ل.س جديد";
        document.getElementById('sRest').innerText = "المتبقي: " + Math.round(rest * 100).toLocaleString() + " ل.س قديم";
    } else {
        document.getElementById('sPay').innerText = "حصتك: " + share.toLocaleString() + " ل.س قديم";
        document.getElementById('sRest').innerText = "المتبقي: " + Math.round(rest / 100).toLocaleString() + " ل.س جديد";
    }
}