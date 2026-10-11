const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw_PEAG-FeMsmmKZ6vGl338lua4wOVsb696EtqNQpwbdZcQWe2H8DcyWfaDl6fbVabr/exec";
const GIPHY_API_KEY = "3N3VPi3QqCKZOwSBO6Tn7vjJvgSLLxck";
let gifSearchTimer;
let allPosts = JSON.parse(localStorage.getItem("gb_cache") || "[]");
let linkPreviewCache = JSON.parse(localStorage.getItem("gb_link_preview_cache") || "{}");
const linkPreviewFetchesInFlight = new Set();
let incomingPostsCache = null; 
let allBios = {}, allAvatars = {};
let allStreaks = []; 
let postsToShow = 10;
let filterType = null, filterVal = null;
let lastPostCount = allPosts.length;
let newPostCount = 0;
let isInfiniteScrollLoading = false;
let scrollTimeout;
let searchDebounceTimer;
let _isPollRunning = false;
let _sidebarCacheRef = null;
function debouncedRender() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(render, 300);
}
let activeCropperInstance = null;
let processedBase64Images = [];
let chosenFilterStyleName = "normal";

let selfieSegmentationModelInstance = null;
let selfieSegmentationLoadPromise = null;
const MEDIAPIPE_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747";

let pendingDeepLinkPost = parseInt(new URLSearchParams(location.search).get('post'), 10) || null;
let lastFeedSignature = "";
let lastNotifiedMentionTime = "";
const ACTIVITY_WINDOW_DAYS = 30;

const filterMatrixConfigurations = {
  normal: 'none',
  film1982: 'none',
  cyberpunk: 'hue-rotate(140deg) saturate(1.8) contrast(1.3) brightness(0.9)',
  vhs90s: 'contrast(1.1) saturate(1.3) brightness(1.05)',
  technopunk: 'none',
  aiportrait: 'none'
};

window.onload = () => {
  document.getElementById('user').value = localStorage.getItem("gb_user") || "";
  lastNotifiedMentionTime = localStorage.getItem("gb_mentions_seen") || "";
  if(allPosts.length > 0) { lastFeedSignature = feedSignature({ posts: allPosts }); render(); }
  loadFeed(); 
  window.addEventListener('scroll', handleWindowScroll, { passive: true });
  setInterval(() => { if (!document.hidden) pollForUpdates(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollForUpdates(); });
  setupReplyEnterKey();
  setupCarouselSwipe();
  setupMentionAutocomplete();
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('mentionsPanel');
    if (panel.classList.contains('show') && !panel.contains(e.target) && !document.getElementById('navBell').contains(e.target)) panel.classList.remove('show');
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
};

// Loaded on demand: only people who pick the AI Portrait filter pay for the download
function loadSelfieSegmentation() {
  if (selfieSegmentationLoadPromise) return selfieSegmentationLoadPromise;
  selfieSegmentationLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${MEDIAPIPE_BASE}/selfie_segmentation.js`;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      selfieSegmentationModelInstance = new SelfieSegmentation({ locateFile: (file) => `${MEDIAPIPE_BASE}/${file}` });
      selfieSegmentationModelInstance.setOptions({ modelSelection: 1 });
      resolve(selfieSegmentationModelInstance);
    };
    script.onerror = () => { selfieSegmentationLoadPromise = null; reject(new Error('MediaPipe failed to load')); };
    document.head.appendChild(script);
  });
  return selfieSegmentationLoadPromise;
}

function initiateCropper(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const targetImg = document.getElementById('cropTargetImage');
    targetImg.src = e.target.result;
    
    chosenFilterStyleName = "normal";
    const container = document.getElementById('cropWorkspaceContainer');
    container.className = "crop-workspace f-normal";
    
    const elements = document.querySelectorAll('.filter-option');
    elements.forEach(el => el.classList.remove('active'));
    if(elements[0]) elements[0].classList.add('active');

    document.querySelectorAll('.filter-preview-box').forEach(box => {
       box.style.backgroundImage = `url('${e.target.result}')`;
    });

    document.getElementById('cropModal').style.display = 'flex';
    if(activeCropperInstance) activeCropperInstance.destroy();
    
    activeCropperInstance = new Cropper(targetImg, {
      aspectRatio: 1,
      viewMode: 1,
      autoCropArea: 1,
      background: false,
      responsive: true
    });
  };
  reader.readAsDataURL(file);
}

function selectPostFilter(filterType, triggerElement) {
  chosenFilterStyleName = filterType;
  document.querySelectorAll('.filter-option').forEach(el => el.classList.remove('active'));
  triggerElement.classList.add('active');
  
  const container = document.getElementById('cropWorkspaceContainer');
  container.className = "crop-workspace f-" + filterType;
  if (filterType === 'aiportrait') loadSelfieSegmentation().catch(() => {});
}

function closeCropModal() {
  document.getElementById('cropModal').style.display = 'none';
  document.getElementById('file').value = "";
  if(activeCropperInstance) activeCropperInstance.destroy();
}

function toggleCommentsVisibility(rowIndex) {
  const tray = document.getElementById(`comments-tray-${rowIndex}`);
  const label = document.getElementById(`toggle-label-${rowIndex}`);
  if(tray.style.display === 'none') {
    tray.style.display = 'block';
    if(label) label.style.display = 'none';
  }
}

function handleWindowScroll() {
  const btn = document.getElementById("backToTop");
  const currentScroll = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
  
  if (currentScroll > 300) {
    btn.style.setProperty('display', 'flex', 'important');
  } else {
    btn.style.setProperty('display', 'none', 'important');
  }

  if (scrollTimeout) return;
  scrollTimeout = setTimeout(() => {
    scrollTimeout = null;

    const documentHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight, document.documentElement.offsetHeight);
    if ((window.innerHeight + currentScroll) >= documentHeight - 400) {
      const filtered = getFilteredPosts();
      if (postsToShow < filtered.length && !isInfiniteScrollLoading) {
        isInfiniteScrollLoading = true;
        postsToShow += 10;
        render();
        setTimeout(() => { isInfiniteScrollLoading = false; }, 200);
      }
    }
  }, 80);
}

async function loadFeed() {
  try {
    const res = await fetch(SCRIPT_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allPosts = data.posts || [];
    allBios = data.bios || {};
    allAvatars = data.avatars || {};
    allStreaks = data.streaks || []; 
    localStorage.setItem("gb_cache", JSON.stringify(allPosts));
    lastPostCount = allPosts.length;
    lastFeedSignature = feedSignature(data);
    incomingPostsCache = null;
    document.getElementById('refreshPill').classList.remove('show');
    render();
    updateMentions(true);
  } catch(e) { console.error("Load failed", e); }
  openDeepLinkedPost();
}

// Cheap fingerprint of everything the feed shows, so any new reaction/comment/bio triggers a refresh
function feedSignature(data) {
  const posts = (data.posts || []).map(p => `${p.rowIndex}:${JSON.stringify(normalizeLikes(p.likes))}:${(p.comments || []).length}:${p.message}`).join('|');
  return posts + JSON.stringify(data.bios || {}) + JSON.stringify(data.avatars || {});
}

// Handles share links like ?post=150
function openDeepLinkedPost() {
  if (!pendingDeepLinkPost || !allPosts.length) return;
  const id = pendingDeepLinkPost;
  pendingDeepLinkPost = null;
  history.replaceState(null, '', location.pathname);
  if (!allPosts.some(p => p.rowIndex === id)) { showNotif("That post couldn't be found — it may have been removed."); return; }
  scrollToPost(id);
}

async function pollForUpdates() {
  if (_isPollRunning) return;
  _isPollRunning = true;
  const isTyping = document.activeElement.tagName === 'INPUT' ||
                   document.activeElement.tagName === 'TEXTAREA';

  if (isTyping) { _isPollRunning = false; return; }

  try {
    const res = await fetch(SCRIPT_URL);
    const data = await res.json();
    const newPosts = data.posts || [];

    if (newPosts.length > lastPostCount) {
      const activeUser = document.getElementById('user').value.trim();
      if (newPosts[0] && !sameUser(newPosts[0].user, activeUser)) {
        newPostCount += (newPosts.length - lastPostCount);
        lastPostCount = newPosts.length;
        incomingPostsCache = data;
        document.getElementById('refreshPill').classList.add('show');
        if (!updateMentions(false, newPosts)) showNotif(`${newPosts[0].user} posted something new!`);
        return;
      }
    }

    const signature = feedSignature(data);
    if (signature !== lastFeedSignature && !incomingPostsCache) {
      lastFeedSignature = signature;
      allPosts = newPosts;
      allBios = data.bios || {};
      allAvatars = data.avatars || {};
      allStreaks = data.streaks || [];
      lastPostCount = newPosts.length;
      localStorage.setItem("gb_cache", JSON.stringify(allPosts));
      render();
      updateMentions(false);
    }
  } catch(e) { console.log("Poll failed, will try again..."); }
  finally { _isPollRunning = false; }
}

function acceptNewPosts() {
  if (incomingPostsCache) {
    allPosts = incomingPostsCache.posts || [];
    allBios = incomingPostsCache.bios || {};
    allAvatars = incomingPostsCache.avatars || {};
    allStreaks = incomingPostsCache.streaks || [];
    localStorage.setItem("gb_cache", JSON.stringify(allPosts));
    lastPostCount = allPosts.length;
    lastFeedSignature = feedSignature(incomingPostsCache);
    incomingPostsCache = null;
  }
  document.getElementById('refreshPill').classList.remove('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  render();
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function extractPreviewUrl(message) {
  if (!message) return null;
  const matches = message.match(/https?:\/\/[^\s<>"]+/g);
  if (!matches) return null;
  for (const raw of matches) {
    const url = raw.replace(/[.,!?;:)\]]+$/, '');
    try {
      const host = new URL(url).hostname.replace('www.', '');
      if (host.includes('youtube.com') || host.includes('youtu.be') || host.includes('music.apple.com') || host.includes('giphy.com')) continue;
      return url;
    } catch { continue; }
  }
  return null;
}

function saveLinkPreviewCache() {
  try {
    const keys = Object.keys(linkPreviewCache);
    if (keys.length > 150) { keys.slice(0, keys.length - 150).forEach(k => delete linkPreviewCache[k]); }
    localStorage.setItem("gb_link_preview_cache", JSON.stringify(linkPreviewCache));
  } catch (e) { /* storage full or unavailable, skip caching */ }
}

function renderLinkPreviewHTML(data, url) {
  const host = (() => { try { return new URL(url).hostname.replace('www.', ''); } catch { return url; } })();
  const site = data.siteName || host;
  const imgHTML = data.image ? `<div class="link-preview-img-wrap"><img class="link-preview-img" src="${escapeHtml(data.image)}" loading="lazy" onerror="this.parentElement.remove()"></div>` : '';
  const titleHTML = data.title ? `<div class="link-preview-title">${escapeHtml(data.title)}</div>` : '';
  const descHTML = data.description ? `<div class="link-preview-desc">${escapeHtml(data.description)}</div>` : '';
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="link-preview-card">${imgHTML}<div class="link-preview-body"><div class="link-preview-site">🔗 ${escapeHtml(site)}</div>${titleHTML}${descHTML}</div></a>`;
}

async function buildLinkPreviewShareHTML(post, amShareMatch) {
  if (amShareMatch) return '';
  const previewUrl = extractPreviewUrl(post.message);
  if (!previewUrl) return '';

  let previewData = linkPreviewCache[previewUrl];
  if (previewData === undefined) {
    previewData = await Promise.race([
      (async () => {
        try {
          const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(previewUrl)}&palette=false`);
          const json = await res.json();
          const d = json && json.data;
          const result = (json.status === 'success' && d && (d.title || (d.image && d.image.url)))
            ? { title: d.title || '', description: d.description || '', image: (d.image && d.image.url) || '', siteName: d.publisher || '' }
            : null;
          linkPreviewCache[previewUrl] = result;
          saveLinkPreviewCache();
          return result;
        } catch { return null; }
      })(),
      new Promise(res => setTimeout(() => res(null), 4000))
    ]);
  }
  if (!previewData) return '';

  const safePreviewImg = previewData.image
    ? await Promise.race([base64CacheProxy(previewData.image), new Promise(res => setTimeout(() => res(""), 3000))])
    : "";
  const previewHost = (() => { try { return new URL(previewUrl).hostname.replace('www.', ''); } catch { return previewUrl; } })();
  return `<div style="margin-top:10px;border:1px solid #e0e2e5;border-radius:10px;overflow:hidden;">
    ${safePreviewImg ? `<img src="${escapeHtml(safePreviewImg)}" style="width:100%;aspect-ratio:1.91/1;object-fit:cover;display:block;">` : ''}
    <div style="padding:10px 12px;background:#fafbfc;text-align:left;">
      <div style="font-size:10px;color:#65676b;text-transform:uppercase;font-weight:bold;letter-spacing:0.3px;margin-bottom:3px;">🔗 ${escapeHtml(previewData.siteName || previewHost)}</div>
      ${previewData.title ? `<div style="font-size:13px;font-weight:bold;color:#1c1e21;line-height:1.3;">${escapeHtml(previewData.title)}</div>` : ''}
    </div>
  </div>`;
}

function applyLinkPreviewToEl(el, url) {
  const data = linkPreviewCache[url];
  if (!data) { el.remove(); return; }
  el.outerHTML = renderLinkPreviewHTML(data, url);
}

function hydrateLinkPreviews() {
  document.querySelectorAll('.link-preview-card.loading').forEach(async (el) => {
    const url = el.dataset.url;
    if (!url) return;
    if (linkPreviewCache[url] !== undefined) { applyLinkPreviewToEl(el, url); return; }
    if (linkPreviewFetchesInFlight.has(url)) return;
    linkPreviewFetchesInFlight.add(url);
    try {
      const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}&palette=false`);
      const json = await res.json();
      const d = json && json.data;
      linkPreviewCache[url] = (json.status === 'success' && d && (d.title || (d.image && d.image.url)))
        ? { title: d.title || '', description: d.description || '', image: (d.image && d.image.url) || '', siteName: d.publisher || '' }
        : null;
    } catch { linkPreviewCache[url] = null; }
    linkPreviewFetchesInFlight.delete(url);
    saveLinkPreviewCache();
    document.querySelectorAll('.link-preview-card.loading').forEach(e => { if (e.dataset.url === url) applyLinkPreviewToEl(e, url); });
  });
}

function base64CacheProxy(url) {
  return new Promise((resolve) => {
    if (!url || url.length < 10) return resolve("");
    if (url.startsWith('data:image')) return resolve(url);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url + (url.includes('?') ? '&' : '?') + 't=' + new Date().getTime();
    
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const outCtx = canvas.getContext('2d');
        outCtx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.9));
      } catch(err) {
        console.warn("CORS proxy canvas write failed.", err);
        resolve(""); 
      }
    };
    img.onerror = () => resolve("");
  });
}

let notifTimer = null;
function showNotif(msg, onClick) {
  const b = document.getElementById('notifBanner');
  document.getElementById('notifText').textContent = "🦄 " + msg;
  b.onclick = () => { dismissNotif(); if (onClick) onClick(); };
  b.classList.add('show');
  document.getElementById('navBadge').textContent = newPostCount;
  document.getElementById('navBadge').style.display = newPostCount > 0 ? 'flex' : 'none';
  clearTimeout(notifTimer);
  notifTimer = setTimeout(dismissNotif, 5000);
}

function dismissNotif() {
  const b = document.getElementById('notifBanner');
  if(b) b.classList.remove('show');
  document.getElementById('navBadge').style.display = 'none';
  newPostCount = 0;
}

function setFilter(type, val) {
  if (filterVal === val && filterType === type) { 
    filterVal = null; filterType = null; 
  } else { 
    filterVal = val; filterType = type; 
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  render();
}

function getAvatarMarkup(user, sizeClass) {
  const ava = ciLookup(allAvatars, user);
  if (!ava || ava === "" || ava === "undefined") return `<div class="${sizeClass}">🦄</div>`;
  return `<img src="${escapeHtml(ava)}" class="${sizeClass}" loading="lazy" onerror="this.outerHTML='<div class=&quot;${sizeClass}&quot;>🦄</div>'">`;
}

async function uploadAvatar(user) {
  const file = document.getElementById('avaPick').files[0];
  if(!file) return;
  const btn = document.getElementById('editBioBtn');
  if(btn) btn.innerText = "Processing...";
  
  const base64 = await compressImage(file);
  const canonical = canonicalUser(user);
  await fetch(SCRIPT_URL, {
    method: 'POST',
    mode: 'no-cors',
    body: JSON.stringify({
      action: 'updateBio',
      username: canonical,
      bio: ciLookup(allBios, user) || "",
      avatar: base64
    })
  });
  setTimeout(async () => { await loadFeed(); if(btn) btn.innerText = "Edit Bio"; render(); }, 1500);
}

async function saveBio(user) {
  const bio = document.getElementById('newBio').value;
  const canonical = canonicalUser(user);
  allBios[canonical] = bio;
  render();
  await fetch(SCRIPT_URL, {
    method: 'POST',
    mode: 'no-cors',
    body: JSON.stringify({
      action: 'updateBio',
      username: canonical,
      bio: bio,
      avatar: ciLookup(allAvatars, user) || ""
    })
  });
  setTimeout(loadFeed, 1000);
}

// Safe for a JS string argument inside a double-quoted HTML attribute: onclick="fn(${jsArg(x)})"
function jsArg(v) { return escapeHtml(JSON.stringify(String(v == null ? '' : v))); }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

let _knownUsersRef = null, _knownUsers = [], _tokenRegex = /(https?:\/\/[^\s]+)|#(\w+)|@(\w+)/g;
// Everyone who has posted, commented or has a profile, using each person's most common spelling
function getKnownUsers() {
  if (_knownUsersRef === allPosts) return _knownUsers;
  _knownUsersRef = allPosts;
  const spellings = {};
  const add = n => {
    n = (n || '').trim(); if (!n) return;
    const k = normUser(n); spellings[k] = spellings[k] || {};
    spellings[k][n] = (spellings[k][n] || 0) + 1;
  };
  allPosts.forEach(p => { add(p.user); (p.comments || []).forEach(c => add(c.user)); });
  Object.keys(allBios).forEach(add); Object.keys(allAvatars).forEach(add);
  _knownUsers = Object.values(spellings).map(v => Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]);
  const names = _knownUsers.map(escapeRegex).sort((a, b) => b.length - a.length);
  // Full names (which can contain spaces and dots) win over a bare @word
  _tokenRegex = new RegExp(`(https?:\\/\\/[^\\s]+)|#(\\w+)|@(${names.length ? `(?:${names.join('|')})(?!\\w)|` : ''}\\w+)`, 'gi');
  return _knownUsers;
}

function renderTextToken(match, url, tag, mention) {
  if (url) {
    const href = escapeHtml(url);
    try {
      let shortName = new URL(url).hostname.replace('www.', '');
      if (shortName.includes('youtube.com') || shortName.includes('youtu.be')) {
        return `<a href="${href}" target="_blank" rel="noopener" style="color:#ff0000; text-decoration:none; font-weight:600; background:#fff0f0; padding:2px 8px; border-radius:4px; display:inline-block; margin:2px 0;">🎬 YouTube</a>`;
      }
      if (shortName.includes('music.apple.com')) {
        return `<a href="${href}" target="_blank" rel="noopener" style="color:#fa243c; text-decoration:none; font-weight:600; background:#fff0f2; padding:2px 8px; border-radius:4px; display:inline-block; margin:2px 0;">🎵 Apple Music</a>`;
      }
      if (shortName.length > 20) shortName = shortName.substring(0, 18) + '...';
      return `<a href="${href}" target="_blank" rel="noopener" style="color:#3b5998; text-decoration:none; font-weight:600; background:#f0f2f5; padding:2px 8px; border-radius:4px; white-space:nowrap; display:inline-block; margin:2px 0;">🔗 ${escapeHtml(shortName)}</a>`;
    } catch(e) {
      const fallback = url.length > 25 ? url.substring(0, 22) + '...' : url;
      return `<a href="${href}" target="_blank" rel="noopener" style="color:#3b5998;">${escapeHtml(fallback)}</a>`;
    }
  }
  if (tag) {
    return `<span style="color:var(--gb-hover);font-weight:bold;cursor:pointer" onclick="setFilter('hashtag',${jsArg(match.toLowerCase())})">${escapeHtml(match)}</span>`;
  }
  if (mention) {
    const known = getKnownUsers().find(n => sameUser(n, mention));
    const click = known ? ` style="cursor:pointer" onclick="setFilter('author',${jsArg(known)})"` : '';
    return `<span class="mention-tag"${click}>@${escapeHtml(mention)}</span>`;
  }
  return escapeHtml(match);
}

// Escapes user text and turns links, #tags and @mentions into markup
function highlightHashtags(t) {
  if (!t) return "";
  getKnownUsers();
  const text = String(t);
  let out = '', last = 0;
  for (const m of text.matchAll(_tokenRegex)) {
    out += escapeHtml(text.slice(last, m.index));
    out += renderTextToken(m[0], m[1], m[2], m[3]);
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function onImageLoad(imgElement) {
  imgElement.classList.add('loaded');
  const skeleton = imgElement.previousElementSibling;
  if (skeleton && skeleton.classList.contains('skeleton-loader')) {
    skeleton.style.display = 'none';
  }
}

function postMatchesSearch(p, s) {
  if (!s) return true;
  if ((p.message || "").toLowerCase().includes(s) || (p.user || "").toLowerCase().includes(s)) return true;
  return (p.comments || []).some(c => (c.text || "").toLowerCase().includes(s) || (c.user || "").toLowerCase().includes(s));
}

function getFilteredPosts() {
  const s = document.getElementById('searchBar').value.trim().toLowerCase();
  let filtered = allPosts.filter(p => postMatchesSearch(p, s));
  if (filterVal) {
    if (filterType === 'author') filtered = filtered.filter(p => sameUser(p.user, filterVal));
    if (filterType === 'likes') filtered = filtered.filter(p => Object.keys(normalizeLikes(p.likes)).some(n => sameUser(n, filterVal)));
    if (filterType === 'hashtag') {
      const tag = filterVal.toLowerCase();
      filtered = filtered.filter(p => (p.message || "").toLowerCase().includes(tag) || (p.comments || []).some(c => (c.text || "").toLowerCase().includes(tag)));
    }
  }
  return filtered;
}

function render() {
  const u = document.getElementById('user').value.trim();
  const s = document.getElementById('searchBar').value.trim().toLowerCase();
  const statusEl = document.getElementById('filterStatus');
  const composer = document.getElementById('postComposer');
  const feedEl = document.getElementById('feed');
  
  const filtered = getFilteredPosts();

  if (filterVal) {
    composer.style.display = "none";
    if (filterType === 'author') {
        const bio = escapeHtml(ciLookup(allBios, filterVal) || "A mysterious Gooldbooker.");
        const isMe = sameUser(filterVal, u);
        statusEl.innerHTML = `<div class="card" style="text-align:center;">${getAvatarMarkup(filterVal, 'avatar-large')}${isMe ? `<input type="file" id="avaPick" style="display:none" onchange="uploadAvatar(${jsArg(u)})"><button class="btn-alt" style="margin-bottom:10px" onclick="document.getElementById('avaPick').click()">Change Photo</button>` : ''}<h2 style="margin:0">${escapeHtml(filterVal)}</h2><p style="font-style:italic; color:#555">"${bio}"</p>${isMe ? `<div id="bioEdit" style="display:none"><textarea id="newBio">${bio}</textarea><button class="btn" onclick="saveBio(${jsArg(u)})">Save</button></div><button class="btn-alt" id="editBioBtn" onclick="document.getElementById('bioEdit').style.display='block'; this.style.display='none'">Edit Bio</button>` : ''}<hr style="border:0; border-top:1px solid #eee; margin:15px 0;"><button class="btn-alt" onclick="setFilter(null,null)">← Back to Feed</button></div>`;
    } else {
        let label = escapeHtml(filterType === 'likes' ? `Liked by ${filterVal}` : `Tagged ${filterVal}`);
        statusEl.innerHTML = `<div class="card" style="display:flex; justify-content:space-between; align-items:center;"><span>Showing: <b>${label}</b></span><button class="btn-alt" onclick="setFilter(null,null)">Clear</button></div>`;
    }
  } else { composer.style.display = "block"; statusEl.innerHTML = ""; }
  
  const totalInFilter = filtered.length;
  const preserved = captureFeedState();

  const feedHTML = filtered.slice(0, postsToShow).map((p, index) => {
    try {
      let mediaHTML = "";
      const imgs = getPostImages(p);
      if (imgs.length === 1) {
        const existingImg = document.querySelector(`#post-${p.rowIndex} .post-img`);
        if (existingImg && existingImg.getAttribute('src') === imgs[0]) {
          mediaHTML = existingImg.closest('.img-container').outerHTML;
        } else {
          mediaHTML = `<div class="img-container"><div class="skeleton-loader"></div><img src="${escapeHtml(imgs[0])}" class="post-img" loading="lazy" onload="onImageLoad(this)"></div>`;
        }
      } else if (imgs.length > 1) {
        const startIdx = Math.min(preserved.carousels[p.rowIndex] || 0, imgs.length - 1);
        mediaHTML = `<div class="carousel" id="carousel-${p.rowIndex}" data-idx="${startIdx}" data-row="${p.rowIndex}">
          ${imgs.map((src, i) => `<img src="${escapeHtml(src)}" class="post-img carousel-slide${i===startIdx?' active':''}" loading="lazy">`).join('')}
          <button class="car-btn car-prev" onclick="carouselMove(${p.rowIndex},-1)">&#8249;</button>
          <button class="car-btn car-next" onclick="carouselMove(${p.rowIndex},1)">&#8250;</button>
          <div class="car-dots">${imgs.map((_,i) => `<span class="car-dot${i===startIdx?' active':''}" onclick="carouselGo(${p.rowIndex},${i})"></span>`).join('')}</div>
        </div>`;
      }

      const ytMatch = (p.message || "").match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (ytMatch && ytMatch[1]) {
        const videoId = ytMatch[1];
        const thumbUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        mediaHTML += `<div style="margin-top:10px; position:relative; aspect-ratio: 16/9; width:100%; overflow:hidden; border-radius:8px; background: #000 url(${thumbUrl}) center/cover no-repeat; cursor:pointer;" onclick="playYouTube(this, '${videoId}')"><div style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); width:60px; height:60px; background:rgba(0,0,0,0.7); border-radius:50%; display:flex; align-items:center; justify-content:center; border:3px solid white;"><div style="width: 0; height: 0; border-top: 15px solid transparent; border-bottom: 15px solid transparent; border-left: 25px solid white; margin-left: 5px;"></div></div><div style="position:absolute; bottom:10px; right:10px; background:rgba(0,0,0,0.8); color:white; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold;">▶ WATCH</div></div>`;
      }

      const amMatch = (p.message || "").match(/https?:\/\/music\.apple\.com\/[^\s"<>]+/);
      if (amMatch) {
        const embedUrl = amMatch[0].replace('https://music.apple.com/', 'https://embed.music.apple.com/');
        mediaHTML += `<div style="margin-top:10px; border-radius:12px; overflow:hidden; width:100%;">
          <iframe allow="autoplay *; encrypted-media *; fullscreen *; clipboard-write"
            frameborder="0" height="175"
            style="width:100%;overflow:hidden;border-radius:12px;background:transparent;"
            sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"
            src="${escapeHtml(embedUrl)}"></iframe>
        </div>`;
      }

      if (!ytMatch && !amMatch) {
        const previewUrl = extractPreviewUrl(p.message);
        if (previewUrl) {
          const cached = linkPreviewCache[previewUrl];
          if (cached === undefined) {
            mediaHTML += `<a href="${escapeHtml(previewUrl)}" target="_blank" rel="noopener" class="link-preview-card loading" data-url="${escapeHtml(previewUrl)}"><div class="link-preview-img-wrap"><div class="skeleton-loader"></div></div></a>`;
          } else if (cached) {
            mediaHTML += renderLinkPreviewHTML(cached, previewUrl);
          }
        }
      }

      const likeBadge = (filterType === 'likes') ? `<span style="color:#e74c3c; font-size:11px; font-weight:normal; background:#fff0f0; padding:2px 6px; border-radius:10px; margin-left:8px; border:1px solid #ffccd5;">❤️ ${index + 1} of ${totalInFilter}</span>` : '';
      const reactions = normalizeLikes(p.likes);
      const reactionCount = Object.keys(reactions).length;
      const likeNames = reactionCount > 0 ? reactionNamesHTML(reactions) : '';
      const reactionBarHTML = ['❤️','🤯','😡','🙄','😉'].map(em => { const cnt = Object.values(reactions).filter(e=>e===em).length; const isActive = ciLookup(reactions, u)===em; return `<button class="reaction-btn${isActive?' active':''}" data-emoji="${em}" onclick="apiCall('like',${p.rowIndex},event,'${em}')">${em}${cnt>0?` <span class='rxn-count'>${cnt}</span>`:''}</button>`; }).join('');
      const comments = p.comments || [];
      const totalCommentsCount = comments.length;
      const trayOpen = preserved.openTrays.has(String(p.rowIndex));
      const initialComments = comments.slice(0, 2);
      const hiddenComments = comments.slice(2);
      
      let toggleLabelHTML = "";
      if(totalCommentsCount > 2 && !trayOpen) { toggleLabelHTML = `<div id="toggle-label-${p.rowIndex}" style="color:var(--gb-blue); font-size:12px; font-weight:bold; margin-top:8px; cursor:pointer;" onclick="toggleCommentsVisibility(${p.rowIndex})">💬 View all ${totalCommentsCount} comments</div>`; }

      return `<div class="card" id="post-${p.rowIndex}"><div class="user-header">${getAvatarMarkup(p.user, 'avatar-small')}<div class="user-info"><div style="display:flex; align-items:center;"><span class="user-name" onclick="setFilter('author', ${jsArg(p.user)})">${escapeHtml(p.user)}</span>${likeBadge}</div><span class="time-stamp">${timeAgo(p.timestamp)}</span></div></div><p style="margin:10px 0;">${highlightHashtags(p.message)}</p>${mediaHTML}<div style="margin-top:12px; display:flex; flex-direction:column; gap:8px;"><div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;"><div class="reaction-bar">${reactionBarHTML}</div><button class="btn-alt" onclick="sharePost(${p.rowIndex}, event)">🔗 Share</button></div><div class="liked-by-container" style="font-size:11px; color:#65676b; margin-left:5px; line-height:1.4; display: ${reactionCount > 0 ? 'block' : 'none'};">Reacted: <span class="liked-by-list">${likeNames}</span></div></div><div class="comment-section" style="margin-top:10px;"><div class="comments-list">${initialComments.map(renderCommentHTML).join('')}${toggleLabelHTML}<div id="comments-tray-${p.rowIndex}" style="display:${trayOpen ? 'block' : 'none'};">${hiddenComments.map(renderCommentHTML).join('')}</div></div><div style="margin-top:10px"><input id="c-${p.rowIndex}" class="reply-input" data-row="${p.rowIndex}" enterkeyhint="send" placeholder="Reply..." style="margin-bottom:0; font-size:13px!important;"><button class="btn-comment" onclick="apiCall('comment', ${p.rowIndex})">Post Reply</button></div></div></div>`;
    } catch (err) { console.error("Error rendering post:", err); return `<div class="card">Error loading this post.</div>`; }
  }).join('');

  feedEl.innerHTML = feedHTML || '<div class="card">No posts found.</div>';
  restoreFeedState(preserved);
  hydrateLinkPreviews();
  
  if (postsToShow < totalInFilter) {
    document.getElementById('loadMore').style.display = 'block';
  } else {
    document.getElementById('loadMore').style.display = 'none';
  }
  
  if (!filterVal && !s) updateSidebar();
}

function commentTime(c) { return c.time || c.timestamp; }

function renderCommentHTML(c) {
  return `<div class="comment-box"><div style="display:flex; justify-content:space-between;"><b>${escapeHtml(c.user)}</b><span style="font-size:10px; color:#888;">${timeAgo(commentTime(c))}</span></div><div>${highlightHashtags(c.text)}</div></div>`;
}

function reactionNamesHTML(reactions) {
  return Object.entries(reactions).map(([n, e]) => `<b style="color:var(--gb-blue); cursor:pointer;" onclick="setFilter('author', ${jsArg(n.trim())})">${escapeHtml(n.trim())} ${e}</b>`).join(', ');
}

// Re-rendering the feed (e.g. on a live update) shouldn't lose a half-typed reply,
// reset a carousel, or collapse comments someone opened
function captureFeedState() {
  const state = { replies: {}, carousels: {}, openTrays: new Set(), focusedId: null };
  document.querySelectorAll('#feed .reply-input').forEach(i => { if (i.value) state.replies[i.id] = i.value; });
  document.querySelectorAll('#feed .carousel').forEach(c => { state.carousels[c.dataset.row] = parseInt(c.dataset.idx) || 0; });
  document.querySelectorAll('#feed [id^="comments-tray-"]').forEach(t => { if (t.style.display === 'block') state.openTrays.add(t.id.replace('comments-tray-', '')); });
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#feed')) state.focusedId = document.activeElement.id;
  return state;
}

function restoreFeedState(state) {
  Object.entries(state.replies).forEach(([id, v]) => { const i = document.getElementById(id); if (i) i.value = v; });
  if (state.focusedId) { const el = document.getElementById(state.focusedId); if (el) el.focus({ preventScroll: true }); }
}

// Local calendar day number, so "consecutive days" follows the viewer's own midnight
function dayIndex(d) { const t = new Date(d); return Math.floor((t.getTime() - t.getTimezoneOffset() * 60000) / 86400000); }

// Days each person posted or commented, keyed by normalized name
function activityDaysByUser() {
  const days = {};
  const add = (name, when) => {
    if (!name || !when || isNaN(new Date(when))) return;
    const k = normUser(name);
    (days[k] = days[k] || new Set()).add(dayIndex(when));
  };
  allPosts.forEach(p => {
    add(p.user, p.timestamp);
    (p.comments || []).forEach(c => add(c.user, commentTime(c)));
  });
  return days;
}

// Consecutive active days ending today (or yesterday, so a streak survives until you miss a whole day)
function currentStreakFromDays(daySet, today) {
  let d = daySet.has(today) ? today : (daySet.has(today - 1) ? today - 1 : null);
  if (d === null) return 0;
  let n = 0;
  while (daySet.has(d)) { n++; d--; }
  return n;
}

function bestStreakInWindow(daySet, today) {
  let best = 0, run = 0;
  for (let d = today - ACTIVITY_WINDOW_DAYS + 1; d <= today; d++) {
    run = daySet.has(d) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

// Streak to report to the server after the user does something today
function currentStreakFor(user) {
  const today = dayIndex(new Date());
  const set = new Set(activityDaysByUser()[normUser(user)] || []);
  set.add(today);
  return currentStreakFromDays(set, today);
}

function isWithinActivityWindow(when) {
  const t = new Date(when).getTime();
  return !isNaN(t) && Date.now() - t <= ACTIVITY_WINDOW_DAYS * 86400000;
}

function updateSidebar() {
  if (_sidebarCacheRef === allPosts) return;
  _sidebarCacheRef = allPosts;
  const myName = document.getElementById('user').value.trim();
  document.getElementById('myProfileLink').innerHTML = myName ? `<div class="sidebar-card" style="cursor:pointer; color:var(--gb-blue); font-weight:bold; display:flex; align-items:center; gap:10px;" onclick="setFilter('author', ${jsArg(myName)})">${getAvatarMarkup(myName, 'avatar-small')} My Profile</div>` : "";
  
  const engagement = p => Object.keys(normalizeLikes(p.likes)).length + (p.comments?.length || 0);
  const recentPosts = allPosts.filter(p => isWithinActivityWindow(p.timestamp));
  const topPosts = [...recentPosts].sort((a,b) => engagement(b) - engagement(a)).slice(0,3);
  document.getElementById('trending').innerHTML = `<div class="sidebar-card"><b style="color: #e67e22;">🔥 Trending Activity</b> <span class="trend-stats" style="display:inline">· last ${ACTIVITY_WINDOW_DAYS} days</span><br>${topPosts.map(p => `<div class="sidebar-item" onclick="scrollToPost(${p.rowIndex})"><div style="font-weight:bold; color:var(--gb-blue);">${escapeHtml(p.user)}</div><div style="font-size:11px; color:#666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(p.message)}</div><span class="trend-stats">❤️ ${Object.keys(normalizeLikes(p.likes)).length} • 💬 ${p.comments.length}</span></div>`).join('') || '<div style="color:#888; font-size:11px; padding:4px 0;">Quiet month!</div>'}</div>`;

  const lCounts = {}; allPosts.forEach(p => Object.keys(normalizeLikes(p.likes)).forEach(n => { const k = ciKey(lCounts, n); lCounts[k] = (lCounts[k]||0)+1; }));
  const topLikers = Object.entries(lCounts).sort((a,b)=>b[1]-a[1]).slice(0,3);
  document.getElementById('leaderboard').innerHTML = `<div class="sidebar-card"><b>🏆 Top Likers</b><br>${topLikers.map(([n,c], i) => `<div class="sidebar-item" onclick="setFilter('likes',${jsArg(n)})">${i===0?'🥇':i===1?'🥈':'🥉'} ${escapeHtml(n)} <b>${c} ❤️</b></div>`).join('')}</div>`;
  
  // Streaks come from real post/comment dates, so they're the same on every device
  const today = dayIndex(new Date());
  const daysByUser = activityDaysByUser();
  const knownUsers = getKnownUsers();
  const streaks = Object.entries(daysByUser).map(([k, set]) => ({
    user: knownUsers.find(n => normUser(n) === k) || k,
    best: bestStreakInWindow(set, today),
    current: currentStreakFromDays(set, today)
  })).filter(x => x.best > 0).sort((a, b) => b.best - a.best || b.current - a.current).slice(0, 3);
  document.getElementById('streakLeaderboard').innerHTML = `
    <div class="sidebar-card">
      <b style="color: #d35400;">👑 Top Streaks</b> <span class="trend-stats" style="display:inline">· last ${ACTIVITY_WINDOW_DAYS} days</span><br>
      ${streaks.map((s, i) => `<div class="sidebar-item" onclick="setFilter('author',${jsArg(s.user)})">${i===0?'👑':i===1?'🔥':'✨'} ${escapeHtml(s.user)} — <b>${s.best} ${s.best === 1 ? 'Day' : 'Days'}</b>${s.current > 0 ? `<span class="trend-stats">🔥 ${s.current}-day streak going now</span>` : ''}</div>`).join('') || '<div style="color:#888; font-size:11px; padding:4px 0;">No active family streaks yet!</div>'}
    </div>
  `;

  const hCounts = {};
  const countTags = text => ((text || "").match(/#(\w+)/g) || []).forEach(t => { const ct = t.toLowerCase().trim(); hCounts[ct] = (hCounts[ct]||0)+1; });
  allPosts.forEach(p => {
    if (isWithinActivityWindow(p.timestamp)) countTags(p.message);
    (p.comments || []).forEach(c => { if (isWithinActivityWindow(commentTime(c) || p.timestamp)) countTags(c.text); });
  });
  const topTags = Object.entries(hCounts).sort((a,b) => b[1] - a[1]).slice(0, 8);
  document.getElementById('hashtags').innerHTML = `<div class="sidebar-card"><b>#️⃣ Trending Tags</b> <span class="trend-stats" style="display:inline">· last ${ACTIVITY_WINDOW_DAYS} days</span><div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;">${topTags.map(([tag, count]) => `<div class="sidebar-item" style="background: #f0f2f5; padding: 5px 10px; border-radius: 15px; font-size: 12px; cursor: pointer;" onclick="setFilter('hashtag',${jsArg(tag)})"><span style="color:var(--gb-hover); font-weight:bold;">${escapeHtml(tag)}</span> <span style="color:#888; font-size: 10px;">${count}</span></div>`).join('') || 'None'}</div></div>`;
}

function playYouTube(el, videoId) {
  el.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}?autoplay=1" style="position:absolute;top:0;left:0;width:100%;height:100%;" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
  el.onclick = null;
}

function openGifPicker() {
  document.getElementById('gifModal').style.display = 'flex';
  document.getElementById('gifSearch').value = '';
  loadTrendingGifs();
}

function closeGifPicker() {
  document.getElementById('gifModal').style.display = 'none';
}

function debouncedGifSearch(query) {
  clearTimeout(gifSearchTimer);
  gifSearchTimer = setTimeout(() => {
    query.trim() ? searchGiphy(query.trim()) : loadTrendingGifs();
  }, 400);
}

async function loadTrendingGifs() {
  const grid = document.getElementById('gifGrid');
  grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:#888;">Loading...</div>';
  try {
    const res = await fetch(`https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=21&rating=g`);
    const data = await res.json();
    renderGifGrid(data.data);
  } catch { grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:#e74c3c;">Could not load GIFs.</div>'; }
}

async function searchGiphy(query) {
  const grid = document.getElementById('gifGrid');
  grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:#888;">Searching...</div>';
  try {
    const res = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=21&rating=g`);
    const data = await res.json();
    renderGifGrid(data.data);
  } catch { grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:#e74c3c;">Search failed.</div>'; }
}

function renderGifGrid(gifs) {
  const grid = document.getElementById('gifGrid');
  if (!gifs || !gifs.length) { grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:#888;">No GIFs found.</div>'; return; }
  grid.innerHTML = gifs.map(g =>
    `<img src="${g.images.fixed_height_small.url}" class="gif-item" onclick="selectGif('${g.images.fixed_height.url}')" loading="lazy">`
  ).join('');
}

function selectGif(gifUrl) {
  if (processedBase64Images.length < 4) {
    processedBase64Images.push(gifUrl);
    updateImagePreviewStrip();
  }
  closeGifPicker();
}

function scrollToPost(id) {
  if (filterVal || document.getElementById('searchBar').value) {
    filterVal = null; filterType = null;
    document.getElementById('searchBar').value = '';
    render();
  }
  performScroll(id);
}
function performScroll(id, attempt = 0) {
  const el = document.getElementById(`post-${id}`);
  if (el) {
    requestAnimationFrame(() => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: 'smooth' }));
    el.classList.add('highlight-card');
    setTimeout(() => el.classList.remove('highlight-card'), 2500);
    return;
  }
  // Show enough posts to include it, but give up if it doesn't exist (avoids an endless loop)
  const idx = getFilteredPosts().findIndex(p => p.rowIndex === id);
  if (idx === -1 || attempt > 0) return;
  postsToShow = Math.max(postsToShow, idx + 5);
  render();
  performScroll(id, attempt + 1);
}

function updateImagePreviewStrip() {
  const strip = document.getElementById('imagePreviewStrip');
  const addBtn = document.getElementById('addAnotherPhotoBtn');
  if (!strip) return;
  strip.innerHTML = processedBase64Images.map((src, i) =>
    `<div class="img-thumb-wrap">
       <img src="${src}" class="img-thumb">
       <button class="img-thumb-remove" onclick="removePostImage(${i})">×</button>
     </div>`
  ).join('');
  strip.style.display = processedBase64Images.length ? 'flex' : 'none';
  if (addBtn) addBtn.style.display = processedBase64Images.length > 0 && processedBase64Images.length < 4 ? 'inline-block' : 'none';
}

function removePostImage(index) {
  processedBase64Images.splice(index, 1);
  updateImagePreviewStrip();
}

function carouselMove(rowIndex, dir) {
  const car = document.getElementById(`carousel-${rowIndex}`);
  const slides = car.querySelectorAll('.carousel-slide');
  const dots = car.querySelectorAll('.car-dot');
  let idx = (parseInt(car.dataset.idx) + dir + slides.length) % slides.length;
  car.dataset.idx = idx;
  slides.forEach((s, i) => s.classList.toggle('active', i === idx));
  dots.forEach((d, i) => d.classList.toggle('active', i === idx));
}

function carouselGo(rowIndex, idx) {
  const car = document.getElementById(`carousel-${rowIndex}`);
  car.dataset.idx = idx;
  car.querySelectorAll('.carousel-slide').forEach((s, i) => s.classList.toggle('active', i === idx));
  car.querySelectorAll('.car-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
}

async function upload() {
  const user = document.getElementById('user').value.trim();
  const msg = document.getElementById('msg').value.trim();
  if(!user || !msg) return alert("Fill in name and message!");
  const postBtn = document.getElementById('postBtn');
  postBtn.innerText = "⏳ Uploading...";
  postBtn.disabled = true;
  
  const currentLocalStreak = String(currentStreakFor(user));
  
  try {
    await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'post',
        username: user,
        message: msg,
        images: processedBase64Images,
        streak: currentLocalStreak
      })
    });

    document.getElementById('msg').value = ""; document.getElementById('file').value = "";
    processedBase64Images = []; updateImagePreviewStrip();
    postBtn.innerText = "✨ Finalizing post...";
    await new Promise(resolve => setTimeout(resolve, 2500));
    await loadFeed(); 
  } catch(e) { console.error("Upload failed:", e); alert("Post creation failed. Please try again."); } finally { postBtn.innerText = "Post Update"; postBtn.disabled = false; }
}

async function compressImage(file) {
  return new Promise(res => {
    const r = new FileReader(); r.readAsDataURL(file);
    r.onload = (e) => {
      const i = new Image(); i.src = e.target.result;
      i.onload = () => {
        // Center-crop to a square instead of squashing the whole photo into one
        const c = document.createElement('canvas'); const m = 400;
        const side = Math.min(i.width, i.height);
        const out = Math.min(side, m);
        c.width = out; c.height = out;
        c.getContext('2d').drawImage(i, (i.width - side) / 2, (i.height - side) / 2, side, side, 0, 0, out, out);
        res(c.toDataURL('image/jpeg', 0.8));
      };
    };
  });
}

function normUser(name) { return (name || '').trim().toLowerCase(); }
function sameUser(a, b) { return normUser(a) === normUser(b); }
function ciKey(obj, key) {
  const target = normUser(key);
  const found = Object.keys(obj).find(k => normUser(k) === target);
  return found !== undefined ? found : key;
}
function ciLookup(obj, key) { return obj[ciKey(obj, key)]; }
function canonicalUser(name) {
  const b = ciKey(allBios, name);
  if (b !== name) return b;
  return ciKey(allAvatars, name);
}

function getPostImages(post) {
  if (Array.isArray(post.images) && post.images.length) return post.images;
  const v = post.image || "";
  if (!v) return [];
  try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : [v]; }
  catch { return [v]; }
}

function normalizeLikes(data) {
  if (!data) return {};
  if (Array.isArray(data)) { const o = {}; data.forEach(n => { if (n) o[String(n)] = '❤️'; }); return o; }
  if (typeof data === 'object') return data;
  return {};
}

async function apiCall(action, rowIndex, event, emoji) {
  const user = document.getElementById('user').value.trim();
  if(!user) return alert("Name required!");

  const currentLocalStreak = String(currentStreakFor(user));

  const p = allPosts.find(x => x.rowIndex === rowIndex);
  if (!p) return;
  const postEl = document.getElementById(`post-${rowIndex}`);

  if(action==='like') {
    const em = emoji || '❤️';
    const reactions = normalizeLikes(p.likes);
    const reactionKey = ciKey(reactions, user);
    const wasReacted = reactions[reactionKey] === em;
    if (wasReacted) { delete reactions[reactionKey]; } else { reactions[reactionKey] = em; }
    p.likes = reactions;
    if (postEl) {
      postEl.querySelectorAll('.reaction-btn').forEach(btn => {
        const bEm = btn.dataset.emoji;
        const cnt = Object.values(reactions).filter(e=>e===bEm).length;
        btn.className = 'reaction-btn' + (reactions[reactionKey]===bEm ? ' active' : '');
        btn.innerHTML = bEm + (cnt > 0 ? ` <span class='rxn-count'>${cnt}</span>` : '');
        if (bEm === em && !wasReacted) { btn.classList.add('pop'); setTimeout(() => btn.classList.remove('pop'), 120); }
      });
      const container = postEl.querySelector('.liked-by-container'); const listSpan = postEl.querySelector('.liked-by-list');
      if (container && listSpan) { if (Object.keys(reactions).length > 0) { listSpan.innerHTML = reactionNamesHTML(reactions); container.style.display = 'block'; } else { container.style.display = 'none'; } }
    }
    if (!wasReacted && event) { const u = document.createElement('div'); u.className='unicorn-pop'; u.textContent=em; u.style.left=event.clientX+'px'; u.style.top=event.clientY+'px'; document.body.appendChild(u); setTimeout(()=>u.remove(), 1500); }

    // PACKAGES STREAK VALUE ON LIKE EXECUTIONS
    await fetch(SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify({ action, rowIndex, username: user, streak: currentLocalStreak, emoji: em })
    });
  } else if (action === 'comment') {
    const input = document.getElementById(`c-${rowIndex}`); if(!input || !input.value.trim()) return; const txt = input.value.trim();
    const newCommentObj = { user, text: txt, time: new Date().toISOString() }; p.comments.push(newCommentObj); input.value = ""; 
    if (postEl) { const list = postEl.querySelector('.comments-list'); if (list) { const div = document.createElement('div'); div.className = 'comment-box'; div.innerHTML = `<div style="display:flex; justify-content:space-between;"><b>${escapeHtml(user)}</b><span style="font-size:10px; color:#888;">just now</span></div><div>${highlightHashtags(txt)}</div>`; list.appendChild(div); } }
    
    // PACKAGES STREAK VALUE ON COMMENT EXECUTIONS
    await fetch(SCRIPT_URL, { 
      method: 'POST', 
      mode: 'no-cors', 
      body: JSON.stringify({ action, rowIndex, username: user, text: txt, streak: currentLocalStreak }) 
    });
  }
}

async function sharePost(rowIndex, event) {
  const post = allPosts.find(p => p.rowIndex === rowIndex);
  if (!post) return;
  const btn = event.target;
  const originalText = btn.innerText;
  btn.innerText = "⏳ Preparing...";

  const shareUrl = `https://karrotz26-rgb.github.io/Gooldbook/?post=${rowIndex}`;
  const shareText = `🦄 ${post.user} on theGooldbook:\n"${(post.message || '').substring(0, 120)}"`;
  const amShareMatch = (post.message || "").match(/https?:\/\/music\.apple\.com\/[^\s"<>]+/);
  const postReactions = normalizeLikes(post.likes);
  const names = Object.keys(postReactions).length > 0
    ? Object.entries(postReactions).map(([n, e]) => `${n} ${e}`).join(', ') : '';

  const imgs = getPostImages(post);
  const carEl = document.getElementById(`carousel-${rowIndex}`);
  const activeIdx = carEl ? parseInt(carEl.dataset.idx || 0) : 0;
  const targetImageUrl = imgs[activeIdx] || "";

  let canvas = null;
  const renderFrame = document.createElement('div');
  renderFrame.style.cssText = `position:fixed;left:-9999px;top:0;width:400px;background:#ffffff;padding:24px;border-radius:12px;font-family:system-ui,-apple-system,sans-serif;color:#1c1e21;box-sizing:border-box;`;

  try {
    const [safeBase64Image, linkPreviewShareHTML, allCommentsHTML] = await Promise.all([
      Promise.race([
        base64CacheProxy(targetImageUrl),
        new Promise(res => setTimeout(() => res(""), 4000))
      ]),
      buildLinkPreviewShareHTML(post, amShareMatch),
      Promise.resolve(post.comments.slice(0, 3).map(c =>
        `<div style="background:#f0f2f5;padding:8px;border-radius:8px;margin-top:5px;font-size:13px;text-align:left;"><b>${escapeHtml(c.user)}</b>: ${escapeHtml(c.text)}</div>`
      ).join(''))
    ]);

    renderFrame.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:15px;">
        <div style="width:36px;height:36px;border-radius:50%;background:#3b5998;display:flex;align-items:center;justify-content:center;font-size:18px;color:white;">🦄</div>
        <div><div style="font-weight:bold;color:#3b5998;">${escapeHtml(post.user)}</div><div style="font-size:11px;color:#888;">theGooldbook 🦄</div></div>
      </div>
      <div style="font-size:15px;margin-bottom:15px;line-height:1.4;color:#1c1e21;">${escapeHtml(post.message)}</div>
      ${safeBase64Image ? `<img src="${safeBase64Image}" style="width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;margin-bottom:10px;display:block;">` : ''}
      <div style="border-top:2px solid #f0f2f5;padding-top:12px;margin-top:5px;">
        <div style="display:flex;gap:15px;font-size:14px;font-weight:bold;color:#65676b;margin-bottom:4px;">
          <span>❤️ ${Object.keys(postReactions).length} Reactions</span>
          <span>💬 ${post.comments.length} Comments</span>
        </div>
        ${names ? `<div style="font-size:11px;color:#888;margin-bottom:10px;">Reacted: <b>${escapeHtml(names)}</b></div>` : ''}
      </div>
      ${amShareMatch ? `<div style="margin-top:10px;padding:10px 12px;background:linear-gradient(135deg,#fc3c44,#c90a31);border-radius:10px;display:flex;align-items:center;gap:10px;"><span style="font-size:26px;">🎵</span><div><div style="color:white;font-weight:bold;font-size:13px;">Apple Music</div><div style="color:rgba(255,255,255,0.8);font-size:11px;word-break:break-all;">${escapeHtml(amShareMatch[0].replace('https://music.apple.com/','').split('?')[0].split('/').slice(0,3).join(' · '))}</div></div></div>` : ''}
      ${linkPreviewShareHTML}
      <div style="margin-top:10px;">${allCommentsHTML}</div>
      <div style="margin-top:15px;border-top:1px dashed #ccc;padding-top:8px;font-size:10px;color:#aaa;text-align:center;font-weight:bold;">SHARED VIA THEGOOLDBOOK 🦄</div>`;

    document.body.appendChild(renderFrame);
    canvas = await Promise.race([
      html2canvas(renderFrame, { useCORS: true, allowTaint: false, scale: 2, backgroundColor: "#ffffff", logging: false, width: 400 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('html2canvas timeout')), 8000))
    ]);
    if (document.body.contains(renderFrame)) document.body.removeChild(renderFrame);

    const imageBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const sharedFile = new File([imageBlob], `Gooldbook_${rowIndex}.png`, { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [sharedFile] })) {
      await navigator.share({ files: [sharedFile], title: 'theGooldbook 🦄', text: shareText });
    } else if (navigator.share) {
      await navigator.share({ title: 'theGooldbook 🦄', text: shareText, url: shareUrl });
    } else {
      shareDownload(canvas, rowIndex);
    }
  } catch(e) {
    if (document.body.contains(renderFrame)) document.body.removeChild(renderFrame);
    if (e.name === 'AbortError') { btn.innerText = originalText; return; }
    // Fallback: plain URL share or clipboard
    try {
      if (navigator.share) {
        await navigator.share({ title: 'theGooldbook 🦄', text: shareText, url: shareUrl });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        btn.innerText = "✅ Copied!";
        setTimeout(() => { btn.innerText = originalText; }, 2000);
        return;
      }
    } catch(e2) {
      if (e2.name !== 'AbortError') {
        try { await navigator.clipboard.writeText(shareUrl); btn.innerText = "✅ Copied!"; setTimeout(() => { btn.innerText = originalText; }, 2000); return; }
        catch { alert(`Post link:\n${shareUrl}`); }
      }
    }
  }
  btn.innerText = originalText;
}

function shareDownload(canvas, rowIndex) {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `Gooldbook_${rowIndex}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function applyImageCropAndFilter() {
  if (!activeCropperInstance) return;
  
  const saveBtn = document.getElementById('applyCropBtn');
  const originalBtnText = saveBtn.innerText;
  saveBtn.innerText = "🧠 AI Processing...";
  saveBtn.disabled = true;

  const croppedCanvas = activeCropperInstance.getCroppedCanvas({ width: 800, height: 800 });
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = 800;
  outputCanvas.height = 800;
  const outContext = outputCanvas.getContext('2d');
  
  let segmenter = null;
  if (chosenFilterStyleName === 'aiportrait') {
    segmenter = await withTimeout(loadSelfieSegmentation(), 20000).catch(() => null);
    if (!segmenter) showNotif("AI Portrait couldn't load — saved without the background blur.");
  }

  if (segmenter) {
    outContext.drawImage(croppedCanvas, 0, 0, 800, 800);

    await withTimeout(new Promise((resolve, reject) => {
      segmenter.onResults((results) => {
        // Blur background via downsample trick (works on iOS — no ctx.filter needed)
        const tiny = document.createElement('canvas');
        tiny.width = 40; tiny.height = 40;
        tiny.getContext('2d').drawImage(results.image, 0, 0, 40, 40);
        const blurC = document.createElement('canvas');
        blurC.width = 800; blurC.height = 800;
        const blurCtx = blurC.getContext('2d');
        blurCtx.imageSmoothingEnabled = true;
        blurCtx.imageSmoothingQuality = 'high';
        blurCtx.drawImage(tiny, 0, 0, 800, 800);

        // Slightly dim and desaturate background via pixel manipulation
        const bgData = blurCtx.getImageData(0, 0, 800, 800);
        const bgPx = bgData.data;
        for (let j = 0; j < bgPx.length; j += 4) {
          const lum = bgPx[j]*0.299 + bgPx[j+1]*0.587 + bgPx[j+2]*0.114;
          bgPx[j]   = Math.min(255, (lum + (bgPx[j]   - lum) * 0.65) * 0.82);
          bgPx[j+1] = Math.min(255, (lum + (bgPx[j+1] - lum) * 0.65) * 0.82);
          bgPx[j+2] = Math.min(255, (lum + (bgPx[j+2] - lum) * 0.65) * 0.82);
        }
        blurCtx.putImageData(bgData, 0, 0);

        // Get segmentation mask pixel data (white = person)
        const maskC = document.createElement('canvas');
        maskC.width = 800; maskC.height = 800;
        maskC.getContext('2d').drawImage(results.segmentationMask, 0, 0, 800, 800);
        const maskPx = maskC.getContext('2d').getImageData(0, 0, 800, 800).data;

        // Get sharp original image pixels
        const origC = document.createElement('canvas');
        origC.width = 800; origC.height = 800;
        origC.getContext('2d').drawImage(results.image, 0, 0, 800, 800);
        const origPx = origC.getContext('2d').getImageData(0, 0, 800, 800).data;

        // Blend: person=sharp original, background=blurred
        const outData = outContext.createImageData(800, 800);
        const op = outData.data;
        for (let j = 0; j < op.length; j += 4) {
          const a = maskPx[j] / 255; // 1=person, 0=background
          op[j]   = origPx[j]   * a + bgPx[j]   * (1 - a);
          op[j+1] = origPx[j+1] * a + bgPx[j+1] * (1 - a);
          op[j+2] = origPx[j+2] * a + bgPx[j+2] * (1 - a);
          op[j+3] = 255;
        }
        outContext.putImageData(outData, 0, 0);

        // Vignette
        const vig = outContext.createRadialGradient(400, 400, 180, 400, 400, 580);
        vig.addColorStop(0, 'rgba(0,0,0,0)');
        vig.addColorStop(1, 'rgba(0,0,0,0.3)');
        outContext.fillStyle = vig;
        outContext.fillRect(0, 0, 800, 800);

        resolve();
      });
      Promise.resolve(segmenter.send({ image: croppedCanvas })).catch(reject);
    }), 20000).catch(() => {
      // Model hung or failed: keep the plain crop that's already drawn
      outContext.drawImage(croppedCanvas, 0, 0, 800, 800);
      showNotif("AI Portrait timed out — saved without the background blur.");
    });
  } else {
    outContext.drawImage(croppedCanvas, 0, 0, 800, 800);
    const imgData = outContext.getImageData(0, 0, 800, 800);
    const pixels = imgData.data;
    
    const leakCenterY = Math.floor(Math.random() * 400) + 200;
    
    for (let i = 0; i < pixels.length; i += 4) {
      let r = pixels[i];
      let g = pixels[i + 1];
      let b = pixels[i + 2];
      
      const currentPixelIndex = i / 4;
      const rowY = Math.floor(currentPixelIndex / 800);
      const colX = currentPixelIndex % 800;
      let modificationAmount = 0;

      if (chosenFilterStyleName === 'film1982') {
        // Warm color matrix
        let tr = (r * 0.42) + (g * 0.73) + (b * 0.22);
        let tg = (r * 0.35) + (g * 0.64) + (b * 0.18);
        let tb = (r * 0.26) + (g * 0.48) + (b * 0.12);
        r = (tr * 0.45 + r * 0.55) * 1.15;
        g = (tg * 0.45 + g * 0.55) * 1.05;
        b = (tb * 0.45 + b * 0.55) * 0.95;

        // Lift blacks — film never goes pure black
        r = r * 0.91 + 18;
        g = g * 0.91 + 13;
        b = b * 0.91 + 8;

        // Split toning: amber warmth in shadows, cool back off in highlights
        const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
        if (lum < 0.55) {
          const shadow = (0.55 - lum) * 1.8;
          r += shadow * 14;
          g += shadow * 4;
          b -= shadow * 6;
        } else {
          const hi = (lum - 0.55) * 0.8;
          r -= hi * 6;
          b += hi * 8;
        }

        // Midtone-weighted grain (strongest in midtones, fades at pure shadows/highlights)
        const midFactor = Math.max(0, 1 - Math.abs(lum - 0.45) * 2.2);
        const grain = (Math.random() - 0.5) * 30 * midFactor;
        r += grain;
        g += grain * 0.9;
        b += grain * 0.75;

        // Left-edge light leak
        if (colX < 280) {
          const leakIntensity = (1 - (colX / 280)) * 65;
          const verticalDistanceFactor = Math.abs(rowY - leakCenterY) / 400;
          if (verticalDistanceFactor < 1) {
            const localizedFalloff = Math.cos(verticalDistanceFactor * Math.PI / 2);
            r += leakIntensity * localizedFalloff * 1.3;
            g += leakIntensity * localizedFalloff * 0.5;
          }
        }

        // Vignette — darken corners like a lens
        const dx = (colX - 400) / 400;
        const dy = (rowY - 400) / 400;
        const vign = 1 - Math.min(1, (dx * dx + dy * dy) * 0.72);
        r *= vign;
        g *= vign;
        b *= vign;
      } 
      else if (chosenFilterStyleName === 'cyberpunk') {
        // hue-rotate(140deg) — W3C color matrix
        const hr = r * (-0.5269) + g * 0.8031 + b * 0.7237;
        const hg = r * 0.4681   + g * 0.5867  + b * (-0.0548);
        const hb = r * (-0.1297) + g * 1.7223  + b * (-0.5926);
        // saturate(1.8) via luminance boost
        const lh = hr * 0.299 + hg * 0.587 + hb * 0.114;
        r = lh + (hr - lh) * 1.8;
        g = lh + (hg - lh) * 1.8;
        b = lh + (hb - lh) * 1.8;
        // brightness(0.9) then contrast(1.3)
        r = (r * 0.9 - 127.5) * 1.3 + 127.5;
        g = (g * 0.9 - 127.5) * 1.3 + 127.5;
        b = (b * 0.9 - 127.5) * 1.3 + 127.5;
      }
      else if (chosenFilterStyleName === 'vhs90s') {
        // saturate(1.3) via luminance boost
        const lv = r * 0.299 + g * 0.587 + b * 0.114;
        r = lv + (r - lv) * 1.3;
        g = lv + (g - lv) * 1.3;
        b = lv + (b - lv) * 1.3;
        // brightness(1.05) then contrast(1.1)
        r = (r * 1.05 - 127.5) * 1.1 + 127.5;
        g = (g * 1.05 - 127.5) * 1.1 + 127.5;
        b = (b * 1.05 - 127.5) * 1.1 + 127.5;
        // scanlines + grain
        if (rowY % 4 === 0) modificationAmount -= 20;
        modificationAmount += (Math.random() - 0.5) * 8;
      } 
      else if (chosenFilterStyleName === 'technopunk') {
        // Replicate CSS: grayscale(1) brightness(0.7) contrast(1.9)
        let v = r * 0.299 + g * 0.587 + b * 0.114; // grayscale
        v = v * 0.7;                                 // brightness(0.7)
        v = (v - 127.5) * 1.9 + 127.5;              // contrast(1.9)
        if (rowY % 5 === 0) v -= 45;                 // scanline bars
        v += (Math.random() - 0.5) * 10;             // subtle grain
        const tv = Math.min(255, Math.max(0, v));
        r = tv; g = tv; b = tv;
        modificationAmount = 0;
      }

      pixels[i]     = Math.min(255, Math.max(0, r + modificationAmount));     
      pixels[i + 1] = Math.min(255, Math.max(0, g + modificationAmount)); 
      pixels[i + 2] = Math.min(255, Math.max(0, b + modificationAmount)); 
    }
    outContext.putImageData(imgData, 0, 0);
  }
  
  if (processedBase64Images.length < 4) {
    processedBase64Images.push(outputCanvas.toDataURL('image/jpeg', 0.85));
  }
  updateImagePreviewStrip();
  saveBtn.innerText = originalBtnText;
  saveBtn.disabled = false;
  document.getElementById('cropModal').style.display = 'none';
  if(activeCropperInstance) activeCropperInstance.destroy();
  activeCropperInstance = null;
}

function timeAgo(d) {
  if (!d || isNaN(new Date(d))) return ""; 
  const dateObj = new Date(d); 
  const diffMs = Date.now() - dateObj.getTime(); 
  const seconds = Math.floor(diffMs / 1000); 
  if (seconds < 60) return "just now";
  const intervals = { yr: 31536000, mo: 2592000, d: 86400, h: 3600, m: 60 };
  if (seconds >= intervals.mo) { return `${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')}/${String(dateObj.getFullYear()).slice(-2)}`; }
  for (let key in intervals) { const counter = Math.floor(seconds / intervals[key]); if (counter > 0) return counter + key; } 
  return "just now";
}

function saveUser() { 
  localStorage.setItem("gb_user", document.getElementById('user').value); 
  _sidebarCacheRef = null;
  lastNotifiedMentionTime = "";
  loadFeed(); 
}

// ---- @mention notifications ----

function mentionsSeenKey(me) { return `gb_mentions_seen_${normUser(me)}`; }

// "@Steven B.", "@StevenB." and "@Steven" all count as mentioning "Steven B."
function mentionsUser(text, me) {
  if (!text || !me || !text.includes('@')) return false;
  const full = normUser(me);
  const aliases = new Set([full, full.replace(/\s+/g, '')]);
  const first = full.split(/\s+/)[0];
  if (first.length >= 3) aliases.add(first);
  return [...aliases].some(a => new RegExp('@' + escapeRegex(a) + '(?![\\w])', 'i').test(text));
}

function collectMentions(posts, me) {
  const found = [];
  posts.forEach(p => {
    if (!sameUser(p.user, me) && mentionsUser(p.message, me)) {
      found.push({ rowIndex: p.rowIndex, by: p.user, text: p.message, time: p.timestamp, kind: 'post' });
    }
    (p.comments || []).forEach(c => {
      if (!sameUser(c.user, me) && mentionsUser(c.text, me)) {
        found.push({ rowIndex: p.rowIndex, by: c.user, text: c.text, time: commentTime(c) || p.timestamp, kind: 'comment' });
      }
    });
  });
  return found.sort((a, b) => new Date(b.time) - new Date(a.time));
}

let currentMentions = [];

// Refreshes the bell; shows a banner for mentions not announced yet. Returns true if it showed one.
function updateMentions(isInitialLoad, postsOverride) {
  const me = document.getElementById('user').value.trim();
  const badge = document.getElementById('bellBadge');
  if (!me) { currentMentions = []; badge.style.display = 'none'; return false; }
  currentMentions = collectMentions(postsOverride || allPosts, me);

  const key = mentionsSeenKey(me);
  let seen = localStorage.getItem(key);
  if (seen === null) {
    // First time on this device: start fresh instead of flagging years of history
    seen = new Date().toISOString();
    localStorage.setItem(key, seen);
  }
  const seenMs = new Date(seen).getTime();
  const unseen = currentMentions.filter(m => new Date(m.time).getTime() > seenMs);
  badge.textContent = unseen.length;
  badge.style.display = unseen.length ? 'flex' : 'none';

  const notifiedMs = Math.max(seenMs, new Date(lastNotifiedMentionTime || 0).getTime());
  const fresh = unseen.filter(m => new Date(m.time).getTime() > notifiedMs);
  if (!fresh.length) return false;
  lastNotifiedMentionTime = fresh[0].time;
  const msg = fresh.length === 1
    ? `${fresh[0].by} mentioned you${fresh[0].kind === 'comment' ? ' in a comment' : ''}!`
    : `You were mentioned ${fresh.length} times${isInitialLoad ? ' while you were away' : ''}!`;
  showNotif(msg, () => openMention(fresh[0].rowIndex));
  return true;
}

function toggleMentionsPanel() {
  const panel = document.getElementById('mentionsPanel');
  if (panel.classList.contains('show')) { panel.classList.remove('show'); return; }
  const me = document.getElementById('user').value.trim();
  if (!me) {
    panel.innerHTML = '<div class="mention-item">Enter your name in the post box to see when people tag you.</div>';
  } else {
    const seenMs = new Date(localStorage.getItem(mentionsSeenKey(me)) || 0).getTime();
    panel.innerHTML = `<div class="mention-item" style="font-weight:bold; cursor:default;">🔔 Mentions</div>` + (currentMentions.slice(0, 30).map(m =>
      `<div class="mention-item${new Date(m.time).getTime() > seenMs ? ' unseen' : ''}" onclick="openMention(${m.rowIndex})"><b>${escapeHtml(m.by)}</b> mentioned you${m.kind === 'comment' ? ' in a comment' : ''} · <span style="color:#888">${timeAgo(m.time)}</span><div class="mention-snippet">${escapeHtml(m.text)}</div></div>`
    ).join('') || '<div class="mention-item" style="color:#888">No one has tagged you yet. Tag someone with @ + their name!</div>');
    if (currentMentions.length) localStorage.setItem(mentionsSeenKey(me), new Date(Math.max(Date.now(), new Date(currentMentions[0].time).getTime())).toISOString());
    document.getElementById('bellBadge').style.display = 'none';
  }
  panel.classList.add('show');
}

function openMention(rowIndex) {
  document.getElementById('mentionsPanel').classList.remove('show');
  if (incomingPostsCache && !allPosts.some(p => p.rowIndex === rowIndex)) acceptNewPosts();
  scrollToPost(rowIndex);
}

// Suggests family names after typing "@" in the post box or a reply box
function setupMentionAutocomplete() {
  const box = document.getElementById('mentionSuggest');
  let target = null, matches = [], active = 0;
  const hide = () => { box.classList.remove('show'); target = null; };
  const isMentionField = el => el && (el.id === 'msg' || (el.classList && el.classList.contains('reply-input')));
  const highlight = () => box.querySelectorAll('[data-i]').forEach((d, i) => d.classList.toggle('active', i === active));

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!isMentionField(el)) return;
    const m = el.value.slice(0, el.selectionStart).match(/(?:^|\s)@([^@\n]{0,20})$/);
    if (!m) return hide();
    const q = normUser(m[1]);
    matches = getKnownUsers().filter(n => normUser(n).startsWith(q) && normUser(n) !== q).slice(0, 5);
    if (!matches.length) return hide();
    target = el; active = 0;
    box.innerHTML = matches.map((n, i) => `<div data-i="${i}">@${escapeHtml(n)}</div>`).join('');
    highlight();
    const r = el.getBoundingClientRect();
    box.style.left = `${Math.max(8, r.left)}px`;
    box.style.top = `${r.bottom + 4}px`;
    box.style.minWidth = `${Math.min(r.width, 240)}px`;
    box.classList.add('show');
  });

  const choose = (i) => {
    if (!target) return;
    const el = target, pos = el.selectionStart;
    const before = el.value.slice(0, pos).replace(/@([^@\n]{0,20})$/, '@' + matches[i] + ' ');
    el.value = before + el.value.slice(pos);
    el.focus();
    el.setSelectionRange(before.length, before.length);
    hide();
  };

  box.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // keep the keyboard open
    const d = e.target.closest('[data-i]');
    if (d) choose(parseInt(d.dataset.i));
  });
  // Capture phase so Enter picks a name instead of sending the reply
  document.addEventListener('keydown', (e) => {
    if (!target || !box.classList.contains('show')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; highlight(); }
    else if (e.key === 'Enter' || e.key === 'Tab') choose(active);
    else if (e.key === 'Escape') hide();
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('focusout', (e) => { if (e.target === target) setTimeout(hide, 150); });
  window.addEventListener('scroll', () => { if (target) hide(); }, { passive: true });
}

// ---- Feed interactions ----

function setupReplyEnterKey() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const el = e.target;
    if (!el.classList || !el.classList.contains('reply-input')) return;
    e.preventDefault();
    apiCall('comment', parseInt(el.dataset.row));
  });
}

function setupCarouselSwipe() {
  let startX = 0, startY = 0, car = null;
  document.addEventListener('touchstart', (e) => {
    car = e.touches.length === 1 ? e.target.closest('.carousel') : null;
    if (car) { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!car) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX, dy = t.clientY - startY;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) carouselMove(parseInt(car.dataset.row), dx < 0 ? 1 : -1);
    car = null;
  }, { passive: true });
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}
