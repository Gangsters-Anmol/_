/**
 * app-tabs.js — Mobile App Shell: Tab Navigation, Search, Profile Tab
 * WhatsApp-style smooth sliding tabs, notifications dropdown, hamburger menu
 */

import { db, SUPER_ADMIN_UID } from './firebase-config.js';
import { onAuthChange, currentUser, currentProfile, showToast } from './auth.js';
import {
  collection, query, orderBy, onSnapshot, doc, updateDoc,
  getDocs, getDoc, addDoc, serverTimestamp, where, limit,
  setDoc, deleteDoc, increment
} from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js';

/* ══ TAB STATE ═══════════════════════════════════════════════ */
const TABS = ['home', 'messages', 'community', 'search', 'profile'];
let _activeTab = 'home';
let _searchHistory = JSON.parse(localStorage.getItem('searchHistory') || '[]');
let _searchFilter = 'all';
let _searchDebounce = null;
let _allUsers = [];
let _notifUnsub = null;
let _profileLikesUnsub = null;

/* ══ DOM REFS ════════════════════════════════════════════════ */
const track       = document.getElementById('tabPanelsTrack');
const bottomBtns  = document.querySelectorAll('.app-bottomnav__btn');
const msgDot      = document.getElementById('msgUnreadDot');
const notifBell   = document.getElementById('appNotifBell');
const notifBadge  = document.getElementById('appNotifBadge');
const notifDropdown = document.getElementById('notifDropdown');
const notifList   = document.getElementById('notifList');
const markAllRead = document.getElementById('markAllRead');
const notifClose  = document.getElementById('notifCloseBtn');
const searchInput = document.getElementById('appSearchInput');
const searchHistEl = document.getElementById('searchHistoryWrap');
const searchResults= document.getElementById('searchResultsList');

/* ══ INIT ════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  _initTabs();
  _initMsgSlider();
  _initMenuLinks();
  _initNotifications();
  _initSearch();
  // Profile tab navigates to profile.html - no init needed
  _initMsgUnreadDot();
  document.body.classList.add('app-mode');
});

/* ══ TAB NAVIGATION ══════════════════════════════════════════ */
function _initTabs() {
  bottomBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tab;
      // Profile tab navigates to profile.html
      if (t === 'profile') {
        if (window.__currentUserUid) {
          window.location.href = 'profile.html?user=' + window.__currentUserUid;
        } else {
          document.getElementById('authBtn')?.click();
        }
        return;
      }
      switchTab(t);
    });
  });
  // Default
  switchTab('home');
}

export function switchTab(tabName) {
  if (!TABS.includes(tabName)) return;
  const idx = TABS.indexOf(tabName);

  // Slide track
  if (track) {
    track.style.transform = `translateX(-${idx * 20}%)`;
  }

  // Update bottom nav (skip profile btn - it has no data-tab, navigates directly)
  bottomBtns.forEach(b => {
    if (!b.dataset.tab) return;
    b.classList.toggle('active', b.dataset.tab === tabName);
  });

  _activeTab = tabName;

  // Lazy-init certain tabs
  if (tabName === 'profile') { /* handled by navigation */ return; }
  if (tabName === 'search')  _renderSearchTab();
}

/* ══ MESSAGES SLIDER (World Chat ↔ Private) ══════════════════ */
function _initMsgSlider() {
  const track2  = document.getElementById('msgPanelsTrack');
  const btns2   = document.querySelectorAll('.msg-slider-btn');
  if (!track2) return;

  btns2.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      btns2.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      track2.style.transform = `translateX(-${i * 50}%)`;
    });
  });
}

/* ══ HAMBURGER MENU — TAB WIRING ════════════════════════════ */
function _initMenuLinks() {
  // Menu links that should switch tabs
  const map = {
    'mnGallery':    () => { switchTab('home'); _scrollTo('memories'); },
    'mnPosts':      () => switchTab('community'),
    'mnChat':       () => switchTab('messages'),
    'mnVoices':     () => { switchTab('home'); _scrollTo('quotes'); },
    'mnAbout':      () => { switchTab('home'); _scrollTo('about'); },
    'mnFamily':     () => { switchTab('home'); _scrollTo('family'); },
    'mnFarewell':   () => { switchTab('home'); _scrollTo('farewell'); },
    'mnSearch':     () => switchTab('search'),
    'mnMyProfile':  () => switchTab('profile'),
    'mnAdminBtn2':  () => document.getElementById('openAdminBtn')?.click(),
  };

  Object.entries(map).forEach(([id, fn]) => {
    document.getElementById(id)?.addEventListener('click', () => {
      closeMobileMenu();
      fn();
    });
  });
}

function _scrollTo(id) {
  setTimeout(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }, 350);
}

function closeMobileMenu() {
  document.getElementById('mobileNavMenu').hidden = true;
  document.getElementById('mobileNavBackdrop').hidden = true;
  document.getElementById('navMenuBtn')?.classList.remove('is-open');
  document.body.style.overflow = '';
}

/* ══ NOTIFICATIONS ═══════════════════════════════════════════ */
function _initNotifications() {
  notifBell?.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = !notifDropdown?.hidden;
    if (isOpen) { notifDropdown.hidden = true; }
    else { notifDropdown.hidden = false; _markNotifsSeen(); }
  });

  notifClose?.addEventListener('click', () => { if (notifDropdown) notifDropdown.hidden = true; });
  markAllRead?.addEventListener('click', _markAllRead);

  document.addEventListener('click', e => {
    if (notifDropdown && !notifDropdown.hidden &&
        !notifDropdown.contains(e.target) &&
        e.target !== notifBell) {
      notifDropdown.hidden = true;
    }
  });

  onAuthChange((user) => {
    if (_notifUnsub) { _notifUnsub(); _notifUnsub = null; }
    if (!user) { _renderNotifEmpty(); return; }
    _subscribeNotifications(user.uid);
  });
}

function _subscribeNotifications(uid) {
  const q = query(
    collection(db, 'users', uid, 'notifications'),
    orderBy('createdAt', 'desc')
    // NO limit — show all
  );

  _notifUnsub = onSnapshot(q, snap => {
    const notifs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const unread = notifs.filter(n => !n.read).length;

    // Update badge
    if (notifBadge) {
      notifBadge.textContent = unread > 99 ? '99+' : unread;
      notifBadge.hidden = unread === 0;
    }

    // Update msg dot for DM notifications
    const hasDMUnread = notifs.some(n => n.type === 'dm' && !n.read);
    if (msgDot) msgDot.hidden = !hasDMUnread;

    _renderNotifList(notifs);
  }, () => {});
}

function _renderNotifList(notifs) {
  if (!notifList) return;
  if (notifs.length === 0) {
    _renderNotifEmpty();
    return;
  }

  const icons = {
    like:     '❤️',
    reaction: '😍',
    comment:  '💬',
    reply:    '↩️',
    follow:   '👤',
    dm:       '✉️',
    story_like: '📖',
    profile_like: '💖',
  };

  notifList.innerHTML = notifs.map(n => {
    const icon = icons[n.type] || '🔔';
    const timeStr = n.createdAt ? _relativeTime(n.createdAt.toDate?.() || new Date(n.createdAt)) : '';
    return `
      <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}">
        <div class="notif-item__icon">
          ${n.fromAvatar
            ? `<img src="${n.fromAvatar}" alt="" onerror="this.parentElement.textContent='${icon}'">`
            : icon}
        </div>
        <div class="notif-item__body">
          <div class="notif-item__text">
            <strong>${_esc(n.fromName || 'Someone')}</strong> ${_esc(n.message || '')}
          </div>
          <div class="notif-item__time">${timeStr}</div>
        </div>
      </div>`;
  }).join('');
}

function _renderNotifEmpty() {
  if (!notifList) return;
  notifList.innerHTML = `
    <div class="notif-empty">
      <div class="notif-empty__icon">🔕</div>
      <div class="notif-empty__text">No notifications yet</div>
    </div>`;
}

async function _markNotifsSeen() {
  if (!currentUser) return;
  const q = query(
    collection(db, 'users', currentUser.uid, 'notifications'),
    where('read', '==', false)
  );
  const snap = await getDocs(q);
  snap.docs.forEach(d => updateDoc(d.ref, { read: true }).catch(() => {}));
}

async function _markAllRead() {
  await _markNotifsSeen();
  if (notifBadge) notifBadge.hidden = true;
}

/* ══ SEARCH TAB ══════════════════════════════════════════════ */
function _initSearch() {
  if (!searchInput) return;

  searchInput.addEventListener('focus', () => {
    _showSearchHistory();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    const q = searchInput.value.trim();
    if (!q) { _showSearchHistory(); return; }
    _searchDebounce = setTimeout(() => _doSearch(q), 300);
  });

  // Filter chips
  document.querySelectorAll('.search-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.search-filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      _searchFilter = chip.dataset.filter;
      const q = searchInput.value.trim();
      if (q) _doSearch(q);
    });
  });

  // Clear history
  document.getElementById('clearSearchHistory')?.addEventListener('click', () => {
    _searchHistory = [];
    localStorage.setItem('searchHistory', '[]');
    _showSearchHistory();
  });
}

function _renderSearchTab() {
  _loadDiscoverPeople();
  _showSearchHistory();
}

function _showSearchHistory() {
  if (!searchHistEl) return;
  const items = document.getElementById('searchHistoryItems');
  if (_searchHistory.length === 0) {
    searchHistEl.classList.remove('visible');
    return;
  }
  searchHistEl.classList.add('visible');
  if (items) {
    items.innerHTML = _searchHistory.slice(0, 8).map((term, i) => `
      <div class="search-history__chip" data-term="${_esc(term)}">
        🕐 ${_esc(term)}
        <span class="search-history__chip-x" data-idx="${i}">✕</span>
      </div>`).join('');

    items.querySelectorAll('.search-history__chip').forEach(chip => {
      chip.addEventListener('click', e => {
        if (e.target.classList.contains('search-history__chip-x')) {
          const idx = parseInt(e.target.dataset.idx);
          _searchHistory.splice(idx, 1);
          localStorage.setItem('searchHistory', JSON.stringify(_searchHistory));
          _showSearchHistory();
        } else {
          searchInput.value = chip.dataset.term;
          _doSearch(chip.dataset.term);
        }
      });
    });
  }
}

async function _doSearch(q) {
  if (!searchResults) return;
  searchHistEl?.classList.remove('visible');

  // Add to history
  if (q && !_searchHistory.includes(q)) {
    _searchHistory.unshift(q);
    if (_searchHistory.length > 20) _searchHistory.pop();
    localStorage.setItem('searchHistory', JSON.stringify(_searchHistory));
  }

  searchResults.innerHTML = '<div class="tab-loading"></div>';

  try {
    if (_allUsers.length === 0) await _loadAllUsers();

    const lower = q.toLowerCase();
    let results = _allUsers.filter(u =>
      (u.displayName || '').toLowerCase().includes(lower) ||
      ( '').toLowerCase().includes(lower)
    );

    if (_searchFilter !== 'all') {
      const filterMap = { students: ['boy', 'girl'], teachers: ['teacher'], parents: ['parent'] };
      const roles = filterMap[_searchFilter] || [];
      results = results.filter(u => roles.includes(u.role));
    }

    if (results.length === 0) {
      searchResults.innerHTML = '<p style="color:var(--clr-muted);font-size:.85rem;padding:.5rem 0;">No results found.</p>';
      return;
    }

    searchResults.innerHTML = results.slice(0, 20).map(u => _renderSearchCard(u)).join('');
    _attachSearchCardListeners();
  } catch(e) {
    searchResults.innerHTML = '<p style="color:var(--clr-muted);font-size:.85rem;">Search error. Try again.</p>';
  }
}

async function _loadAllUsers() {
  const snap = await getDocs(collection(db, 'users'));
  _allUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

async function _loadDiscoverPeople() {
  const discover = document.getElementById('discoverPeopleList');
  if (!discover) return;
  discover.innerHTML = '<div class="tab-loading"></div>';

  try {
    if (_allUsers.length === 0) await _loadAllUsers();
    const toShow = _allUsers
      .filter(u => u.uid !== currentUser?.uid)
      .slice(0, 7);

    discover.innerHTML = toShow.map(u => _renderSearchCard(u)).join('');
    _attachSearchCardListeners();
  } catch(e) {
    discover.innerHTML = '';
  }
}

function _renderSearchCard(u) {
  // Never expose email — use name or displayName (Firestore uses 'name' field), never email
  const displayName = (u.name && u.name.trim()) ? u.name.trim() : (u.displayName && u.displayName.trim() ? u.displayName.trim() : 'Unknown');
  const initials = displayName[0].toUpperCase();
  const roleLabel = u.role ? _capitalize(u.role) : '';

  // Only show green dot when strictly online
  const isOnline = u.online === true;
  const onlineDot = isOnline ? '<div class="search-user-online"></div>' : '';

  // Last seen — only show if not online and lastSeen exists
  let statusText;
  if (isOnline) {
    statusText = '<span style="color:var(--clr-success);font-size:.72rem;">● Online</span>';
  } else if (u.lastSeen) {
    statusText = `Last seen ${_relativeTime(u.lastSeen.toDate?.() || new Date(u.lastSeen))}`;
  } else {
    statusText = 'Offline';
  }

  const isFollowing = currentProfile?.following?.includes(u.uid);
  const followers = u.followersCount || 0;

  return `
    <div class="search-user-card" data-uid="${u.uid}">
      <div class="search-user-avatar">
        ${u.photoURL ? `<img src="${u.photoURL}" alt="" onerror="this.remove()">` : initials}
        ${onlineDot}
      </div>
      <div class="search-user-info">
        <div class="search-user-name">
          ${_esc(displayName)}
          ${u.specialUser ? '<span style="color:#f5a623;font-size:.7rem;">⭐</span>' : ''}
          ${u.role === 'teacher' ? '<span style="font-size:.7rem;">🎓</span>' : ''}
        </div>
        <div class="search-user-meta">
          ${roleLabel} · ${statusText} · ${followers} follower${followers !== 1 ? 's' : ''}
        </div>
      </div>
      <button class="search-follow-btn ${isFollowing ? 'following' : ''}"
              data-uid="${u.uid}"
              data-action="follow">
        ${isFollowing ? '✓ Following' : '+ Follow'}
      </button>
    </div>`;
}

function _attachSearchCardListeners() {
  document.querySelectorAll('.search-user-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.classList.contains('search-follow-btn') || e.target.closest('.search-follow-btn')) return;
      const uid = card.dataset.uid;
      if (uid) window.location.href = `profile.html?user=${uid}`;
    });
  });

  document.querySelectorAll('.search-follow-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!currentUser) { showToast('Login to follow'); return; }
      const targetUid = btn.dataset.uid;
      // Delegate to existing follow.js
      window.dispatchEvent(new CustomEvent('app:follow', { detail: { targetUid } }));
      const isFollowing = btn.classList.contains('following');
      btn.classList.toggle('following', !isFollowing);
      btn.textContent = isFollowing ? '+ Follow' : '✓ Following';
    });
  });
}

/* ══ PROFILE TAB ═════════════════════════════════════════════ */
function _initProfileTab() {
  onAuthChange((user, profile) => {
    if (_activeTab === 'profile') _renderProfileTab();
  });

  document.getElementById('editBioBtn')?.addEventListener('click', _openEditBioModal);
  document.getElementById('editCoverBtn')?.addEventListener('click', _openCoverPicker);
  document.getElementById('profileAvatarChangeBtn')?.addEventListener('click', _openAvatarPicker);
  document.getElementById('saveBioBtn')?.addEventListener('click', _saveBio);
  document.getElementById('cancelBioBtn')?.addEventListener('click', _closeEditBioModal);
}

async function _renderProfileTab() {
  if (!currentUser) {
    document.getElementById('profileTabContent').innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:300px;gap:1rem;color:var(--clr-muted);">
        <div style="font-size:3rem;">👤</div>
        <p>Login to see your profile</p>
        <button onclick="document.getElementById('authBtn').click()" 
                style="padding:.5rem 1.5rem;background:var(--clr-accent);color:#fff;border:none;border-radius:999px;cursor:pointer;font-family:var(--font-body);">
          Login
        </button>
      </div>`;
    return;
  }

  // Load fresh profile
  let profile = currentProfile;
  if (!profile) {
    try {
      const snap = await getDoc(doc(db, 'users', currentUser.uid));
      profile = snap.data();
    } catch(e) {}
  }
  if (!profile) return;

  const initials = (profile.displayName || currentUser.email || '?')[0].toUpperCase();
  const instaBadge = profile.instagramUrl
    ? `<a class="profile-insta-link" href="${_esc(profile.instagramUrl)}" target="_blank" rel="noopener">
         <span>📸</span> Instagram
       </a>` : '';

  const roleBadges = [
    profile.role ? `<span class="role-badge role-badge--${profile.role}">${_capitalize(profile.role)}</span>` : '',
    profile.specialUser ? `<span class="role-badge role-badge--special">⭐ Special</span>` : '',
    profile.isModerator ? `<span class="role-badge role-badge--mod">🛡 Mod</span>` : '',
    profile.uid === SUPER_ADMIN_UID || currentUser.uid === SUPER_ADMIN_UID
      ? `<span class="role-badge role-badge--admin">⚡ Admin</span>` : '',
  ].filter(Boolean).join('');

  document.getElementById('profileTabContent').innerHTML = `
    <div class="my-profile-banner" id="myProfileBanner" style="${profile.coverURL ? `background-image:url('${profile.coverURL}');background-size:cover;background-position:center;` : ''}">
      ${profile.coverURL ? `<img src="${profile.coverURL}" alt="Cover" style="display:none">` : ''}
      <button class="my-profile-banner-edit" id="editCoverBtn">🖼 Edit Cover</button>
    </div>
    <div class="my-profile-header">
      <div class="my-profile-avatar-wrap">
        <div class="my-profile-avatar" id="profileAvatarWrap" style="cursor:pointer" title="Change avatar">
          ${profile.photoURL
            ? `<img src="${profile.photoURL}" alt="${_esc(profile.displayName)}" onerror="this.remove()">`
            : initials}
        </div>
        <div class="my-profile-actions">
          <button class="profile-edit-bio-btn" id="editBioBtn">✎ Edit Bio</button>
        </div>
      </div>
      <div class="my-profile-name">${_esc(profile.displayName || 'User')} ${roleBadges}</div>
      <div class="my-profile-bio">${_esc(profile.bio || '')}</div>
      ${instaBadge}
    </div>
    <div class="my-profile-stats">
      <div class="my-profile-stat">
        <span class="my-profile-stat__num">${profile.postsCount || 0}</span>
        <span class="my-profile-stat__label">Posts</span>
      </div>
      <div class="my-profile-stat" id="profileFollowersBtn">
        <span class="my-profile-stat__num">${profile.followersCount || 0}</span>
        <span class="my-profile-stat__label">Followers</span>
      </div>
      <div class="my-profile-stat" id="profileFollowingBtn">
        <span class="my-profile-stat__num">${profile.followingCount || 0}</span>
        <span class="my-profile-stat__label">Following</span>
      </div>
      <div class="my-profile-stat">
        <span class="my-profile-stat__num">${profile.profileLikes || 0}</span>
        <span class="my-profile-stat__label">❤️ Likes</span>
      </div>
    </div>
    <div class="profile-inner-tabs">
      <button class="profile-inner-tab active" data-ptab="posts">📸 Posts</button>
      <button class="profile-inner-tab" data-ptab="followers">👥 Followers</button>
      <button class="profile-inner-tab" data-ptab="following">➕ Following</button>
    </div>
    <div id="profileTabInner" class="px-1">
      <div id="myPostsGrid" class="my-posts-grid"></div>
    </div>`;

  // Wire inner tabs
  document.querySelectorAll('.profile-inner-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.profile-inner-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      _loadProfileInnerTab(tab.dataset.ptab, profile);
    });
  });

  // Wire edit cover
  document.getElementById('editCoverBtn')?.addEventListener('click', _openCoverPicker);
  document.getElementById('profileAvatarWrap')?.addEventListener('click', _openAvatarPicker);
  document.getElementById('editBioBtn')?.addEventListener('click', _openEditBioModal);

  // Load posts by default
  _loadProfileInnerTab('posts', profile);

  // Subscribe to profile likes
  
}

async function _loadProfileInnerTab(tab, profile) {
  const inner = document.getElementById('profileTabInner');
  if (!inner) return;

  if (tab === 'posts') {
    inner.innerHTML = '<div class="tab-loading"></div>';
    try {
      const q = query(
        collection(db, 'posts'),
        where('authorId', '==', currentUser.uid),
        orderBy('createdAt', 'desc')
      );
      const snap = await getDocs(q);
      const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      if (posts.length === 0) {
        inner.innerHTML = '<p style="text-align:center;color:var(--clr-muted);padding:2rem;font-size:.85rem;">No posts yet.<br>Share your first memory in Community!</p>';
        return;
      }

      inner.innerHTML = `
        <div class="my-posts-grid">
          ${posts.map(p => {
            const media = p.media?.[0];
            if (media?.type === 'video') {
              return `<div class="my-post-thumb" data-post="${p.id}">
                <video src="${media.url}" muted></video>
                <div class="my-post-thumb__overlay">▶ ${p.likeCount||0}❤</div>
              </div>`;
            } else if (media?.url) {
              return `<div class="my-post-thumb" data-post="${p.id}">
                <img src="${media.url}" alt="" loading="lazy">
                <div class="my-post-thumb__overlay">❤ ${p.likeCount||0}</div>
              </div>`;
            } else {
              return `<div class="my-post-thumb" data-post="${p.id}" 
                           style="background:var(--clr-surface2);display:flex;align-items:center;justify-content:center;padding:.5rem;">
                <p style="font-size:.7rem;color:var(--clr-text2);text-align:center;overflow:hidden;max-height:80px;">${_esc((p.content||'').slice(0,80))}</p>
                <div class="my-post-thumb__overlay">❤ ${p.likeCount||0}</div>
              </div>`;
            }
          }).join('')}
        </div>`;
    } catch(e) {
      inner.innerHTML = '<p style="color:var(--clr-muted);text-align:center;padding:2rem;">Could not load posts.</p>';
    }
  }

  else if (tab === 'followers') {
    inner.innerHTML = '<div class="tab-loading"></div>';
    try {
      const followers = profile.followers || [];
      if (followers.length === 0) { inner.innerHTML = '<p style="text-align:center;color:var(--clr-muted);padding:2rem;font-size:.85rem;">No followers yet.</p>'; return; }
      const cards = await Promise.all(followers.map(async uid => {
        try {
          const snap = await getDoc(doc(db, 'users', uid));
          const u = snap.data();
          if (!u) return '';
          const initials = (u.displayName || '?')[0].toUpperCase();
          return `<div class="search-user-card" onclick="window.location.href='profile.html?user=${uid}'">
            <div class="search-user-avatar">${u.photoURL ? `<img src="${u.photoURL}" alt="">` : initials}</div>
            <div class="search-user-info">
              <div class="search-user-name">${_esc(u.displayName  || 'Unknown')}</div>
              <div class="search-user-meta">${_capitalize(u.role||'')} · ${u.followersCount||0} followers</div>
            </div>
          </div>`;
        } catch(e) { return ''; }
      }));
      inner.innerHTML = `<div style="padding:0 1rem">${cards.join('')}</div>`;
    } catch(e) { inner.innerHTML = ''; }
  }

  else if (tab === 'following') {
    inner.innerHTML = '<div class="tab-loading"></div>';
    try {
      const following = profile.following || [];
      if (following.length === 0) { inner.innerHTML = '<p style="text-align:center;color:var(--clr-muted);padding:2rem;font-size:.85rem;">Not following anyone yet.</p>'; return; }
      const cards = await Promise.all(following.map(async uid => {
        try {
          const snap = await getDoc(doc(db, 'users', uid));
          const u = snap.data();
          if (!u) return '';
          const initials = (u.displayName || '?')[0].toUpperCase();
          return `<div class="search-user-card" onclick="window.location.href='profile.html?user=${uid}'">
            <div class="search-user-avatar">${u.photoURL ? `<img src="${u.photoURL}" alt="">` : initials}</div>
            <div class="search-user-info">
              <div class="search-user-name">${_esc(u.displayName  || 'Unknown')}</div>
              <div class="search-user-meta">${_capitalize(u.role||'')} · ${u.followersCount||0} followers</div>
            </div>
            <button class="search-follow-btn following" data-uid="${uid}" data-action="follow">✓ Following</button>
          </div>`;
        } catch(e) { return ''; }
      }));
      inner.innerHTML = `<div style="padding:0 1rem">${cards.join('')}</div>`;
    } catch(e) { inner.innerHTML = ''; }
  }
}

/* ══ EDIT BIO MODAL ══════════════════════════════════════════ */
function _openEditBioModal() {
  const modal = document.getElementById('editBioModal');
  if (!modal) return;
  // Pre-fill
  const profile = currentProfile;
  if (profile) {
    const bioField = document.getElementById('editBioField');
    const nameField = document.getElementById('editNameField');
    const instaField = document.getElementById('editInstaField');
    if (bioField) bioField.value = profile.bio || '';
    if (nameField) nameField.value = profile.displayName || '';
    if (instaField) instaField.value = profile.instagramUrl || '';
  }
  modal.hidden = false;
}

function _closeEditBioModal() {
  const modal = document.getElementById('editBioModal');
  if (modal) modal.hidden = true;
}

async function _saveBio() {
  if (!currentUser) return;
  const bio   = document.getElementById('editBioField')?.value.trim() || '';
  const name  = document.getElementById('editNameField')?.value.trim() || '';
  const insta = document.getElementById('editInstaField')?.value.trim() || '';

  try {
    await updateDoc(doc(db, 'users', currentUser.uid), {
      bio,
      displayName: name || undefined,
      instagramUrl: insta || null,
    });
    showToast('Profile updated! ✨');
    _closeEditBioModal();
    _renderProfileTab();
  } catch(e) {
    showToast('Error saving profile');
  }
}

/* ══ COVER & AVATAR PICKERS ══════════════════════════════════ */
function _openCoverPicker() {
  if (!currentUser) return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Image too large (max 5MB)'); return; }
    showToast('Uploading cover...');
    try {
      const url = await _uploadToCloudinary(file);
      await updateDoc(doc(db, 'users', currentUser.uid), { coverURL: url });
      showToast('Cover updated! 🎨');
      _renderProfileTab();
    } catch(e) { showToast('Upload failed'); }
  };
  inp.click();
}

function _openAvatarPicker() {
  if (!currentUser) return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { showToast('Image too large (max 3MB)'); return; }
    showToast('Updating avatar...');
    try {
      const url = await _uploadToCloudinary(file);
      await updateDoc(doc(db, 'users', currentUser.uid), { photoURL: url });
      showToast('Avatar updated! 📸');
      _renderProfileTab();
    } catch(e) { showToast('Upload failed'); }
  };
  inp.click();
}

async function _uploadToCloudinary(file) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', 'ghost_user');
  const res = await fetch('https://api.cloudinary.com/v1_1/dsbsinbun/auto/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (!data.secure_url) throw new Error('Upload failed');
  return data.secure_url;
}

/* ══ MSG UNREAD DOT ══════════════════════════════════════════ */
function _initMsgUnreadDot() {
  onAuthChange(user => {
    if (!user) return;
    // Listen to unread DMs
    const q = query(
      collection(db, 'users', user.uid, 'notifications'),
      where('type', '==', 'dm'),
      where('read', '==', false)
    );
    onSnapshot(q, snap => {
      if (msgDot) msgDot.hidden = snap.empty;
    }, () => {});
  });
}

/* ══ HELPERS ═════════════════════════════════════════════════ */
function _relativeTime(date) {
  if (!date) return '';
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60)   return 'just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
