const $=s=>document.querySelector(s);let selectedRoom=null,available=[];const ci=$('#checkIn'),co=$('#checkOut'),type=$('#roomType');const today=new Date();today.setHours(0,0,0,0);ci.min=today.toISOString().slice(0,10);co.min=ci.min;ci.addEventListener('change',()=>{co.min=ci.value;if(co.value&&co.value<=ci.value)co.value=''})
$('#checkBtn').onclick=async()=>{const box=$('#availability');box.innerHTML='';selectedRoom=null;$('#guestFields').classList.add('hidden');$('#bookingMsg').textContent='';if(!ci.value||!co.value)return $('#bookingMsg').textContent='Please select check-in and check-out dates.';const r=await fetch(`/api/availability?checkIn=${ci.value}&checkOut=${co.value}&type=${type.value}`);const d=await r.json();if(!r.ok)return $('#bookingMsg').textContent=d.error;available=d.rooms||[];if(!available.length){box.textContent='No rooms of this type are available for these dates.';return}box.innerHTML='<span style="width:100%;color:#777;font-size:12px">Available room numbers</span>'+available.map(x=>`<button type="button" class="room-choice" data-room="${x.number}">Room ${x.number}</button>`).join('');box.querySelectorAll('.room-choice').forEach(b=>b.onclick=()=>{box.querySelectorAll('.room-choice').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');selectedRoom=b.dataset.room;$('#guestFields').classList.remove('hidden');const nights=Math.ceil((new Date(co.value)-new Date(ci.value))/86400000);$('#total').textContent=`${nights} night${nights>1?'s':''} · ${Number({Single:1546,King:2060,Double:2576,Family:4120}[type.value])*nights.toLocaleString()} ETB`})};
$('#bookingForm').onsubmit=async e=>{e.preventDefault();if(!selectedRoom)return $('#bookingMsg').textContent='Select an available room number first.';const body={roomType:type.value,roomNumber:selectedRoom,checkIn:ci.value,checkOut:co.value,guest:{fullName:$('#fullName').value,phone:$('#phone').value,email:$('#email').value,notes:$('#notes').value}};const r=await fetch('/api/bookings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)return $('#bookingMsg').textContent=d.error;currentBookingId=d.booking.id;$('#guestFields').classList.add('hidden');const gate=$('#paymentGate');gate.classList.remove('hidden');$('#payGateTotal').textContent=`Total: ${d.booking.total.toLocaleString()} ETB — Booking ${d.booking.id}`;$('#cbeAccountDisplay').textContent=`1000737388747 — Palm Palace Hotel — Send ${d.booking.total.toLocaleString()} ETB`;$('#bookingMsg').textContent='';};
let currentBookingId=null;
$('#payGateBtn').addEventListener('click',async()=>{
  if(!currentBookingId)return;
  const code=$('#payCode').value;
  const r=await fetch(`/api/bookings/${currentBookingId}/confirm-payment`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:code})});
  const d=await r.json();
  if(!r.ok){$('#bookingMsg').textContent=d.error||'Could not confirm payment.';return;}
  $('#paymentGate').classList.add('hidden');
  $('#bookingMsg').textContent=`Booking ${d.booking.id} confirmed! We look forward to your stay.`;
});

// Auto-rotating photo carousels for the event cards (Conference Hall / Terrace / Catering)
document.querySelectorAll('.event-carousel').forEach(car => {
  const slides = [...car.querySelectorAll('.event-slide')];
  if (slides.length < 2) return;
  let i = slides.findIndex(s => s.classList.contains('active'));
  if (i < 0) i = 0;
  const interval = Number(car.dataset.interval) || 4000;
  setInterval(() => {
    if (document.documentElement.getAttribute('data-motion') === 'reduced') return;
    slides[i].classList.remove('active');
    i = (i + 1) % slides.length;
    slides[i].classList.add('active');
  }, interval);
});

// 360 room viewer (Pannellum) with a friendly fallback when a room's panorama isn't uploaded yet
(function () {
  const modal = $('#panoModal'), viewerEl = $('#panoViewer'), titleEl = $('#panoTitle'), fallbackEl = $('#panoFallbackMsg');
  let panoInstance = null;
  function closeModal() {
    modal.hidden = true;
    if (panoInstance) { panoInstance.destroy(); panoInstance = null; }
  }
  document.querySelectorAll('.view360-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const room = btn.dataset.room, url = btn.dataset.panorama;
      titleEl.textContent = `${room} Room — 360° View`;
      modal.hidden = false;
      const probe = new Image();
      probe.onload = () => {
        fallbackEl.hidden = true;
        viewerEl.hidden = false;
        if (panoInstance) panoInstance.destroy();
        panoInstance = window.pannellum.viewer('panoViewer', {
          type: 'equirectangular', panorama: url, autoLoad: true, compass: false,
          haov: 360, vaov: 64, vOffset: 0,
          showControls: true, hfov: 100
        });
      };
      probe.onerror = () => { viewerEl.hidden = true; fallbackEl.hidden = false; };
      probe.src = url;
    });
  });
  $('.pano-close')?.addEventListener('click', closeModal);
  modal?.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
})();

// Dark / Light theme toggle (persisted per browser) — two-button sun/moon switch
(function () {
  const root = document.documentElement;
  const buttons = [...document.querySelectorAll('.theme-switch button')];
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    buttons.forEach(b => b.classList.toggle('active', b.dataset.mode === theme));
  }
  let saved = null;
  try { saved = localStorage.getItem('ppTheme'); } catch (e) {}
  apply(saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  buttons.forEach(b => b.addEventListener('click', () => {
    apply(b.dataset.mode);
    try { localStorage.setItem('ppTheme', b.dataset.mode); } catch (e) {}
  }));
})();

// Hamburger full-screen nav panel
(function () {
  const btn = $('#hamburgerBtn'), panel = $('#navPanel'), closeBtn = $('#navPanelClose');
  function open() { panel.hidden = false; requestAnimationFrame(() => panel.classList.add('open')); btn.setAttribute('aria-expanded', 'true'); }
  function close() { panel.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); setTimeout(() => { panel.hidden = true; }, 350); }
  btn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  panel?.addEventListener('click', e => { if (e.target === panel) close(); });
  panel?.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel && !panel.hidden) close(); });
})();

// Accessibility panel: Reduced Motion toggle (persisted, actually disables carousels/animations)
(function () {
  const root = document.documentElement;
  const btn = $('#a11yBtn'), panel = $('#a11yPanel');
  const buttons = panel ? [...panel.querySelectorAll('button[data-motion]')] : [];
  function apply(mode) {
    root.setAttribute('data-motion', mode);
    buttons.forEach(b => b.classList.toggle('active', b.dataset.motion === mode));
  }
  let saved = null;
  try { saved = localStorage.getItem('ppMotion'); } catch (e) {}
  apply(saved || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full'));
  btn?.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  buttons.forEach(b => b.addEventListener('click', () => {
    apply(b.dataset.motion);
    try { localStorage.setItem('ppMotion', b.dataset.motion); } catch (e) {}
  }));
  document.addEventListener('click', e => { if (panel && !panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) panel.hidden = true; });
})();

// Watch Video — placeholder until a real hotel video is provided
$('#watchVideoBtn')?.addEventListener('click', () => {
  alert('A hotel walkthrough video will be added here soon.');
});

// Social media links — replace with the hotel's real URLs
const SOCIAL_LINKS = {
  facebook: '',
  instagram: 'https://www.instagram.com/palmpalacehotel?stkn=MWw4bXptY21nN3dzdg==',
  tiktok: 'https://www.tiktok.com/@palm.palace.hotel',
  youtube: '',
  telegram: ''
};
(function () {
  const el = $('#socialLinks');
  if (!el) return;
  const icons = {
    facebook: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M13.5 21v-7.5H16l.4-3H13.5V8.4c0-.9.2-1.5 1.5-1.5H16.5V4.2A20 20 0 0 0 14 4c-2.5 0-4.2 1.5-4.2 4.3v2.2H7v3h2.8V21Z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="3.6"/><circle cx="17.2" cy="6.8" r="1"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M14 3c.4 2.2 1.9 3.8 4.2 4v2.8c-1.5 0-2.9-.5-4.2-1.3V15a5.6 5.6 0 1 1-5.6-5.6c.3 0 .6 0 .9.1v2.9a2.7 2.7 0 1 0 2 2.6V3Z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><rect x="2.5" y="6" width="19" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 9.5v5l4.5-2.5z"/></svg>',
    telegram: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M21 4 2.5 11.3c-.9.4-.9 1.6.1 1.9l4.4 1.4 1.7 5.4c.3.9 1.5 1 2 .1l2.3-3.6 4.6 3.4c.8.6 1.9.1 2.1-.8L22.9 5.3c.2-1-.9-1.7-1.9-1.3ZM8.5 13.9l8.8-6.4-7 7.6-.3 3.1z"/></svg>'
  };
  Object.entries(SOCIAL_LINKS).forEach(([name, url]) => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('aria-label', name);
    a.innerHTML = icons[name] || '';
    el.appendChild(a);
  });
})();

// Room carousel: continuous auto-scroll, working arrows, synced dots, pauses on interaction / Reduced Motion
(function () {
  const wrap = $('#roomCarousel'), track = $('#roomTrack'), dotsWrap = $('#roomDots');
  if (!wrap || !track) return;
  const originals = [...track.children];
  originals.forEach(c => track.appendChild(c.cloneNode(true))); // duplicate once for seamless loop
  const cardGap = 18;
  function cardStep() { return (originals[0].offsetWidth || 280) + cardGap; }
  function singleSetWidth() { return track.scrollWidth / 2; }
  let paused = false, resumeTimer = null;
  function pauseTemporarily() {
    paused = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { paused = false; }, 3500);
  }
  wrap.addEventListener('mouseenter', () => { paused = true; });
  wrap.addEventListener('mouseleave', () => { clearTimeout(resumeTimer); paused = false; });
  wrap.addEventListener('touchstart', () => { paused = true; }, { passive: true });
  wrap.addEventListener('touchend', pauseTemporarily);
  $('.rc-prev')?.addEventListener('click', () => { pauseTemporarily(); wrap.scrollBy({ left: -cardStep(), behavior: 'smooth' }); });
  $('.rc-next')?.addEventListener('click', () => { pauseTemporarily(); wrap.scrollBy({ left: cardStep(), behavior: 'smooth' }); });
  const dotEls = originals.map((_, i) => {
    const d = document.createElement('button');
    d.type = 'button'; d.setAttribute('aria-label', 'Go to room ' + (i + 1));
    d.addEventListener('click', () => { pauseTemporarily(); wrap.scrollTo({ left: i * cardStep(), behavior: 'smooth' }); });
    dotsWrap?.appendChild(d);
    return d;
  });
  function updateDots() {
    if (!dotEls.length) return;
    const idx = Math.round((wrap.scrollLeft % singleSetWidth()) / cardStep()) % originals.length;
    dotEls.forEach((d, i) => d.classList.toggle('active', i === idx));
  }
  function tick() {
    if (!paused && document.documentElement.getAttribute('data-motion') !== 'reduced') {
      wrap.scrollLeft += 0.6;
      if (wrap.scrollLeft >= singleSetWidth()) wrap.scrollLeft -= singleSetWidth();
    }
    updateDots();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

// Gallery rail: same continuous auto-scroll + arrows + dots pattern as the room carousel
(function () {
  const wrap = $('#galleryRail'), track = $('#galleryTrack'), dotsWrap = $('#galDots');
  if (!wrap || !track) return;
  const originals = [...track.children];
  originals.forEach(c => track.appendChild(c.cloneNode(true)));
  const gap = 14;
  function step() { return (originals[0].offsetWidth || 340) + gap; }
  function singleSetWidth() { return track.scrollWidth / 2; }
  let paused = false, resumeTimer = null;
  function pauseTemporarily() {
    paused = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { paused = false; }, 3500);
  }
  wrap.addEventListener('mouseenter', () => { paused = true; });
  wrap.addEventListener('mouseleave', () => { clearTimeout(resumeTimer); paused = false; });
  wrap.addEventListener('touchstart', () => { paused = true; }, { passive: true });
  wrap.addEventListener('touchend', pauseTemporarily);
  $('#galPrev')?.addEventListener('click', () => { pauseTemporarily(); wrap.scrollBy({ left: -step(), behavior: 'smooth' }); });
  $('#galNext')?.addEventListener('click', () => { pauseTemporarily(); wrap.scrollBy({ left: step(), behavior: 'smooth' }); });
  const dotEls = originals.slice(0, 6).map((_, i) => {
    const d = document.createElement('button');
    d.type = 'button'; d.setAttribute('aria-label', 'Go to photo ' + (i + 1));
    d.addEventListener('click', () => { pauseTemporarily(); wrap.scrollTo({ left: i * step(), behavior: 'smooth' }); });
    dotsWrap?.appendChild(d);
    return d;
  });
  function updateDots() {
    if (!dotEls.length) return;
    const idx = Math.round((wrap.scrollLeft % singleSetWidth()) / step()) % dotEls.length;
    dotEls.forEach((d, i) => d.classList.toggle('active', i === idx));
  }
  function tick() {
    if (!paused && document.documentElement.getAttribute('data-motion') !== 'reduced') {
      wrap.scrollLeft += 0.5;
      if (wrap.scrollLeft >= singleSetWidth()) wrap.scrollLeft -= singleSetWidth();
    }
    updateDots();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

// Tap the CBE account line to copy it (account number + amount) for pasting into the USSD prompt
$('#cbeAccountDisplay')?.addEventListener('click', () => {
  const text = $('#cbeAccountDisplay').textContent;
  navigator.clipboard?.writeText(text).then(() => {
    const original = $('#cbeAccountDisplay').textContent;
    $('#cbeAccountDisplay').textContent = 'Copied!';
    setTimeout(() => { $('#cbeAccountDisplay').textContent = original; }, 1200);
  }).catch(() => {});
});

// If ArifPay is configured on the server, use it (redirect to its hosted checkout).
// Otherwise the *889# USSD link (already set as this button's href) is used as-is.
$('#cbeUssdBtn')?.addEventListener('click', async (e) => {
  if (!currentBookingId) return;
  e.preventDefault();
  try {
    const r = await fetch(`/api/bookings/${currentBookingId}/payment-intent`, { method: 'POST' });
    const d = await r.json();
    if (r.ok && d.paymentUrl) { window.location.href = d.paymentUrl; return; }
  } catch (err) {}
  window.location.href = 'tel:*889%23'; // fallback: manual USSD flow
});
