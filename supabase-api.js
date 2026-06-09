/**
 * ============================================================================
 *  supabase-api.js — data layer ของหน้าเว็บบน GitHub (เรียก Supabase ตรง)
 *
 *  กลยุทธ์: ทำ shim ของ google.script.run → โค้ด component เดิม (ใน index.html)
 *  เรียก backend เหมือนเดิมทุกอย่าง โดยไม่ต้องแก้ component เลย
 *    - data (อ่าน/เขียน DB) → supabase-js ตรง (RLS+JWT คุมสิทธิ์)
 *    - login + upload       → fetch ไป GAS Web App (webapp.gs)
 *
 *  ต้องโหลดก่อนไฟล์นี้: supabase-js (CDN) และ config.js
 * ============================================================================
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: false }
  });
  window.sb = sb; // เผื่อ debug

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  function pick(p) { return p.then(function (r) { if (r.error) throw r.error; return r.data; }); }
  function one(p) { return p.then(function (r) { if (r.error) throw r.error; return (r.data && r.data[0]) || null; }); }
  function countRows(table) {
    return sb.from(table).select('*', { count: 'exact', head: true })
      .then(function (r) { if (r.error) throw r.error; return r.count || 0; });
  }
  var num = function (v) { return (v === '' || v == null || isNaN(Number(v))) ? null : Number(v); };

  // เรียก GAS Web App (login / upload) — simple request (text/plain) เลี่ยง CORS preflight
  function gasCall(action, payload) {
    return fetch(CFG.GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, payload: payload || {} })
    }).then(function (res) { return res.json(); });
  }

  // -------------------------------------------------------------------------
  // BACKEND — implement ทุกฟังก์ชันที่ frontend เรียก (ชื่อตรงกับ รหัส.js)
  // -------------------------------------------------------------------------
  var BACKEND = {};

  // ===== AUTH + UPLOAD (ผ่าน GAS Web App) =====
  BACKEND.loginWithPassword = function (username, password) {
    return gasCall('loginWithPassword', { username: username, password: password }).then(_afterLogin);
  };
  BACKEND.loginWithFace = function (descriptor) {
    return gasCall('loginWithFace', { descriptor: descriptor }).then(_afterLogin);
  };
  BACKEND.registerFaceData = function (userId, descriptor) {
    return gasCall('registerFaceData', { userId: userId, descriptor: descriptor });
  };
  BACKEND.uploadProfileImage = function (base64, contentType, username) {
    return gasCall('uploadProfileImage', { base64: base64, contentType: contentType, username: username });
  };
  BACKEND.uploadProjectFile = function (form) { return gasCall('uploadProjectFile', form); };
  BACKEND.uploadAwardEvidence = function (fileData, projectId, type) {
    return gasCall('uploadAwardEvidence', { fileData: fileData, projectId: projectId, type: type });
  };
  BACKEND.uploadPostImage = function (fileData) { return gasCall('uploadPostImage', { fileData: fileData }); };

  var currentToken = null; // JWT ปัจจุบัน (ใช้แนบตอนเรียก action ที่ต้องพิสูจน์ตัวตน)
  var _refreshTimer = null;
  var _lastRefresh = 0;

  // ตั้ง Supabase session ด้วย JWT ที่ GAS เซ็นให้ → RLS ทำงาน
  function _afterLogin(res) {
    if (res && res.success && res.supabaseToken) {
      return _applyToken(res.supabaseToken).then(function () { return res; });
    }
    return res;
  }

  function _applyToken(token) {
    currentToken = token;
    _lastRefresh = Date.now();
    _startRefreshTimer();
    return sb.auth.setSession({ access_token: token, refresh_token: token });
  }

  // ต่ออายุ JWT ผ่าน GAS (ต้องเรียกตอน token ยัง valid) — token ใหม่อายุอีก 8 ชม.
  function refreshSession() {
    if (!currentToken) return Promise.resolve();
    return gasCall('refreshToken', { callerToken: currentToken }).then(function (r) {
      if (r && r.success && r.supabaseToken) return _applyToken(r.supabaseToken);
      // token หมดอายุ/ผิด → ปล่อยให้ flow login จัดการ (RLS จะปฏิเสธ query)
      console.warn('[supabase-api] ต่ออายุ token ไม่สำเร็จ:', r && r.message);
    }).catch(function (e) { console.warn('[supabase-api] refresh error', e); });
  }
  window.refreshSupabaseSession = refreshSession; // เผื่อเรียกเอง/debug

  function _startRefreshTimer() {
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(refreshSession, 6 * 60 * 60 * 1000); // ทุก 6 ชม. (อายุ token 8 ชม.)
  }

  // กลับมาโฟกัสแท็บ (เช่นเครื่อง sleep มา) → ต่ออายุถ้าผ่านมาเกิน 30 นาที
  window.addEventListener('focus', function () {
    if (currentToken && Date.now() - _lastRefresh > 30 * 60 * 1000) refreshSession();
  });

  // ตอนโหลดหน้า: ถ้ามี session ค้างอยู่ (persistSession) ให้ดึง token มาต่ออายุต่อ
  sb.auth.getSession().then(function (r) {
    if (r && r.data && r.data.session && r.data.session.access_token) {
      currentToken = r.data.session.access_token;
      _lastRefresh = Date.now();
      _startRefreshTimer();
    }
  });

  // ===== USER =====
  BACKEND.getUserDetails = function (username) {
    return one(sb.from('user_profiles').select('*').eq('username', String(username).trim()).limit(1))
      .then(function (r) {
        var e = { pictureprofileURL: '', classroom: '', number: '', prefix: '', firstname: '', lastname: '', nickname: '', birthday: '', telephone: '', line: '', facebook: '', ig: '' };
        if (!r) return e;
        return {
          pictureprofileURL: r.picture_url || '', classroom: r.classroom || '', number: r.number || '',
          prefix: r.prefix || '', firstname: r.firstname || '', lastname: r.lastname || '',
          nickname: r.nickname || '', birthday: r.birthday || '', telephone: r.telephone || '',
          line: r.line || '', facebook: r.facebook || '', ig: r.ig || ''
        };
      });
  };

  BACKEND.updateUserProfile = function (data) {
    var username = String(data.username).trim();
    return pick(sb.from('user_profiles').upsert({
      username: username, picture_url: data.pictureprofileURL, classroom: data.classroom, number: data.number,
      prefix: data.prefix, firstname: data.firstname, lastname: data.lastname, nickname: data.nickname,
      birthday: data.birthday, telephone: data.telephone, line: data.line, facebook: data.facebook, ig: data.ig
    }).select()).then(function () {
      if (data.newPassword) return gasCall('__setpw__', { callerToken: currentToken, username: username, password: data.newPassword });
    }).then(function () { return { success: true, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' }; });
  };

  BACKEND.getAllUsersForSelector = function () {
    return Promise.all([
      pick(sb.from('users').select('username,role')),
      pick(sb.from('user_profiles').select('username,prefix,firstname,lastname'))
    ]).then(function (a) {
      var users = a[0], profs = a[1], nameMap = {};
      profs.forEach(function (d) { nameMap[d.username] = (d.prefix || '') + (d.firstname || '') + ' ' + (d.lastname || ''); });
      var out = [];
      users.forEach(function (u) {
        if (u.username === 'admin') return;
        out.push({ username: u.username, role: u.role ? String(u.role).toLowerCase() : 'student', name: nameMap[u.username] || u.username });
      });
      return out;
    });
  };

  BACKEND.getUserNameMap = function () {
    return pick(sb.from('user_profiles').select('username,picture_url,prefix,firstname,lastname')).then(function (rows) {
      var m = {};
      rows.forEach(function (row) {
        if (!row.username) return;
        var full = (row.prefix || '') + (row.firstname || '') + ' ' + (row.lastname || '');
        m[row.username] = { name: full.trim() || row.username, image: row.picture_url || '' };
      });
      m['admin'] = { name: 'Administrator', image: '' };
      return m;
    });
  };

  // map ช่วย: username -> {name, image} / "first last"
  function userInfoMap() {
    return pick(sb.from('user_profiles').select('username,picture_url,prefix,firstname,lastname')).then(function (rows) {
      var m = {};
      rows.forEach(function (u) {
        var uname = String(u.username).trim();
        var full = ((u.prefix || '') + (u.firstname || '') + ' ' + (u.lastname || '')).trim();
        m[uname] = { name: full || uname, image: u.picture_url || '' };
      });
      return m;
    });
  }
  function nameMapShort() {
    return pick(sb.from('user_profiles').select('username,firstname,lastname')).then(function (rows) {
      var m = {}; rows.forEach(function (u) { m[u.username] = ((u.firstname || '') + ' ' + (u.lastname || '')).trim(); }); return m;
    });
  }

  BACKEND.getImportHelperData = function () {
    return Promise.all([
      pick(sb.from('users').select('username,role')),
      pick(sb.from('user_profiles').select('username,prefix,firstname,lastname,nickname')),
      pick(sb.from('projects').select('pj_id,year'))
    ]).then(function (a) {
      var userRaw = a[0], profs = a[1], projects = a[2], detailMap = {};
      profs.forEach(function (u) {
        detailMap[u.username] = ((u.prefix || '') + (u.firstname || '') + ' ' + (u.lastname || '') + ' ' + (u.nickname ? '(' + u.nickname + ')' : '')).trim();
      });
      var users = [];
      userRaw.forEach(function (row) {
        var un = String(row.username).trim(); if (un === 'admin') return;
        users.push({ username: un, name: detailMap[un] || '(ไม่ระบุชื่อ)', role: row.role || 'student' });
      });
      var existingKeys = projects.map(function (p) { return String(p.pj_id).trim() + '_' + String(p.year).trim(); });
      return { users: users, existingKeys: existingKeys };
    });
  };

  // ===== PROJECT =====
  function projectLinks(pjId, members, advisors) {
    var dedupe = function (arr) { var s = {}, o = []; (arr || []).forEach(function (u) { if (u && !s[u]) { s[u] = 1; o.push({ project_id: pjId, username: String(u) }); } }); return o; };
    var m = dedupe(members), a = dedupe(advisors), tasks = [];
    if (m.length) tasks.push(pick(sb.from('project_members').upsert(m).select()));
    if (a.length) tasks.push(pick(sb.from('project_advisors').upsert(a).select()));
    return Promise.all(tasks);
  }

  BACKEND.createProject = function (data) {
    return countRows('projects').then(function (count) {
      var pj_id = 'PJ' + data.pj_year + ('0000' + (count + 1)).slice(-4);
      return pick(sb.from('projects').insert({
        pj_id: pj_id, category: data.pj_category, name: data.pj_name,
        education_level: data.pj_education_level, year: parseInt(data.pj_year, 10) || null
      }).select()).then(function () { return projectLinks(pj_id, data.pj_member, data.pj_advisor); })
        .then(function () { return { success: true, message: 'สร้างโครงงานเรียบร้อยแล้ว', pj_ID: pj_id }; });
    }).catch(function (e) { return { success: false, message: String(e.message || e) }; });
  };

  BACKEND.batchImportProjects = function (projects) {
    var rows = projects.map(function (p) {
      return { pj_id: String(p.pj_ID), category: p.pj_category, name: p.pj_name, education_level: p.pj_education_level, year: parseInt(p.pj_year, 10) || null };
    });
    return pick(sb.from('projects').upsert(rows).select())
      .then(function () { return Promise.all(projects.map(function (p) { return projectLinks(String(p.pj_ID), p.pj_member, p.pj_advisor); })); })
      .then(function () { return { success: true, count: rows.length }; })
      .catch(function (e) { return { success: false, message: String(e.message || e) }; });
  };

  BACKEND.getAllProjectsWithDetails = function () {
    return Promise.all([
      nameMapWithNick(),
      pick(sb.from('projects').select('pj_id,category,name,education_level,year,project_members(username),project_advisors(username)').order('pj_id', { ascending: true }))
    ]).then(function (a) {
      var userMap = a[0], rows = a[1];
      var out = rows.map(function (r) {
        var mem = (r.project_members || []).map(function (x) { return x.username; });
        var adv = (r.project_advisors || []).map(function (x) { return x.username; });
        return {
          pj_ID: r.pj_id, pj_category: r.category, pj_name: r.name,
          pj_member_raw: JSON.stringify(mem), pj_advisor_raw: JSON.stringify(adv),
          pj_member_names: mem.map(function (id) { return userMap[id] || id; }).join(', '),
          pj_advisor_names: adv.map(function (id) { return userMap[id] || id; }).join(', '),
          pj_education_level: r.education_level, pj_year: String(r.year)
        };
      });
      return out.reverse();
    });
  };
  function nameMapWithNick() {
    return pick(sb.from('user_profiles').select('username,firstname,lastname,nickname')).then(function (rows) {
      var m = {}; rows.forEach(function (u) { m[u.username] = ((u.firstname || '') + ' ' + (u.lastname || '') + ' (' + (u.nickname || '') + ')').trim(); }); return m;
    });
  }

  BACKEND.getProjectsForCommittee = function (year, level) {
    return pick(sb.from('projects').select('pj_id,name,category').eq('year', year).eq('education_level', level))
      .then(function (rows) { return rows.map(function (r) { return { pj_ID: r.pj_id, pj_name: r.name, pj_category: r.category }; }); });
  };

  function projectIdsByAdvisor(username) {
    return pick(sb.from('project_advisors').select('project_id').ilike('username', username)).then(function (rows) { return rows.map(function (x) { return x.project_id; }); });
  }
  function fullProjectsByIds(ids) {
    if (!ids || !ids.length) return Promise.resolve([]);
    return pick(sb.from('projects').select('pj_id,category,name,education_level,year,project_members(username),project_advisors(username)').in('pj_id', ids));
  }

  BACKEND.getProjectsByAdvisor = function (username) {
    return fullProjectsByIds([]).then(function () { return projectIdsByAdvisor(username); }).then(fullProjectsByIds)
      .then(function (rows) {
        return rows.map(function (r) {
          return {
            id: r.pj_id, category: r.category, name: r.name,
            students: JSON.stringify((r.project_members || []).map(function (x) { return x.username; })),
            advisors: JSON.stringify((r.project_advisors || []).map(function (x) { return x.username; })),
            level: r.education_level, year: String(r.year)
          };
        });
      });
  };

  BACKEND.getTeacherMyProjects = function (username) {
    return Promise.all([userInfoMap(), projectIdsByAdvisor(username).then(fullProjectsByIds)]).then(function (a) {
      var userMap = a[0], rows = a[1];
      var resolve = function (list) { return (list || []).filter(Boolean).map(function (u) { var i = userMap[u] || { name: u, image: '' }; return { username: u, name: i.name, image: i.image }; }); };
      return rows.map(function (r) {
        return { id: r.pj_id, type: r.category, name: r.name, description: r.education_level, year: String(r.year),
          students: resolve((r.project_members || []).map(function (x) { return x.username; })),
          advisors: resolve((r.project_advisors || []).map(function (x) { return x.username; })) };
      });
    });
  };

  BACKEND.getStudentData = function (username) {
    return pick(sb.from('project_members').select('project_id').ilike('username', username))
      .then(function (rows) { return fullProjectsByIds(rows.map(function (x) { return x.project_id; })); })
      .then(function (rows) {
        return rows.map(function (r) {
          return { pj_ID: r.pj_id, pj_category: r.category, pj_name: r.name,
            pj_member: JSON.stringify((r.project_members || []).map(function (x) { return x.username; })),
            pj_advisor: JSON.stringify((r.project_advisors || []).map(function (x) { return x.username; })),
            pj_level: r.education_level, pj_year: String(r.year) };
        });
      });
  };

  BACKEND.updateAdminProject = function (data) {
    return one(sb.from('projects').select('pj_id').eq('pj_id', data.pj_ID).limit(1)).then(function (ex) {
      if (!ex) return { success: false, message: 'ไม่พบรหัสโครงงานนี้ในระบบ' };
      return pick(sb.from('projects').update({ category: data.pj_category, name: data.pj_name, education_level: data.pj_education_level, year: parseInt(data.pj_year, 10) || null }).eq('pj_id', data.pj_ID).select())
        .then(function () { return pick(sb.from('project_members').delete().eq('project_id', data.pj_ID).select()); })
        .then(function () { return pick(sb.from('project_advisors').delete().eq('project_id', data.pj_ID).select()); })
        .then(function () { return projectLinks(data.pj_ID, data.pj_member, data.pj_advisor); })
        .then(function () { return { success: true, message: 'อัปเดตข้อมูลเรียบร้อยแล้ว' }; });
    }).catch(function (e) { return { success: false, message: 'Error: ' + (e.message || e) }; });
  };

  // updateStudentProject: ไม่เคยมีใน รหัส.js (โค้ดเดิมเรียกแต่ backend ไม่มี) —
  // ใส่ stub กัน error; นักเรียนแก้ข้อมูลผ่าน submitProjectEditRequest อยู่แล้ว
  BACKEND.updateStudentProject = function (p) {
    return Promise.resolve({ success: false, message: 'การแก้ไขโดยตรงไม่รองรับ — กรุณาส่งคำร้องขอแก้ไข' });
  };

  // ===== COMMITTEE =====
  function dedupeLinks(arr, parentCol, parentVal, valCol) {
    var s = {}, o = [];
    (arr || []).forEach(function (v) { if (v != null && !s[v]) { s[v] = 1; var x = {}; x[parentCol] = parentVal; x[valCol] = String(v); o.push(x); } });
    return o;
  }
  BACKEND.saveCommitteeAssignment = function (data) {
    var id = data.id || ('GRP' + Date.now());
    return pick(sb.from('evaluation_committees').upsert({ id: id, round_id: data.round_id, year: parseInt(data.year, 10) || null, level: data.level }).select())
      .then(function () { return pick(sb.from('committee_members').delete().eq('committee_id', id).select()); })
      .then(function () { return pick(sb.from('committee_assigned_projects').delete().eq('committee_id', id).select()); })
      .then(function () {
        var mem = dedupeLinks(data.committee_members, 'committee_id', id, 'username');
        var prj = dedupeLinks(data.assigned_projects, 'committee_id', id, 'project_id');
        return Promise.all([
          mem.length ? pick(sb.from('committee_members').insert(mem).select()) : null,
          prj.length ? pick(sb.from('committee_assigned_projects').insert(prj).select()) : null
        ]);
      }).then(function () { return { success: true, message: 'บันทึกข้อมูลกรรมการเรียบร้อย' }; })
      .catch(function (e) { return { success: false, message: String(e.message || e) }; });
  };
  BACKEND.getCommitteeAssignments = function (roundId, year, level) {
    return Promise.all([
      nameMapShort(),
      pick(sb.from('projects').select('pj_id,name')),
      pick(sb.from('evaluation_committees').select('id,committee_members(username),committee_assigned_projects(project_id)').eq('round_id', roundId).eq('year', year).eq('level', level))
    ]).then(function (a) {
      var userMap = a[0], pjMap = {}, rows = a[2];
      a[1].forEach(function (p) { pjMap[p.pj_id] = p.name; });
      return rows.map(function (r) {
        var members = (r.committee_members || []).map(function (x) { return x.username; });
        var projects = (r.committee_assigned_projects || []).map(function (x) { return x.project_id; });
        return { id: r.id, committee_members: members, assigned_projects: projects,
          member_names: members.map(function (m) { return userMap[m] || m; }),
          project_names: projects.map(function (p) { return { id: p, name: pjMap[p] || p }; }) };
      });
    });
  };
  BACKEND.deleteCommitteeGroup = function (id) {
    return pick(sb.from('evaluation_committees').delete().eq('id', id).select())
      .then(function (d) { return (d && d.length) ? { success: true } : { success: false, message: 'ไม่พบข้อมูล' }; });
  };
  BACKEND.copyCommitteeGroups = function (sourceRoundId, targetRoundId, year, level) {
    return pick(sb.from('evaluation_committees').select('id,committee_members(username),committee_assigned_projects(project_id)').eq('round_id', sourceRoundId).eq('year', year).eq('level', level))
      .then(function (rows) {
        if (!rows.length) return { success: false, message: 'ไม่พบข้อมูลกลุ่มกรรมการในรอบที่เลือก' };
        var chain = Promise.resolve(), count = 0;
        rows.forEach(function (r, idx) {
          var newId = 'GRP' + Date.now() + '_' + idx;
          chain = chain.then(function () { return pick(sb.from('evaluation_committees').insert({ id: newId, round_id: targetRoundId, year: parseInt(year, 10) || null, level: level }).select()); })
            .then(function () {
              var mem = (r.committee_members || []).map(function (x) { return { committee_id: newId, username: x.username }; });
              var prj = (r.committee_assigned_projects || []).map(function (x) { return { committee_id: newId, project_id: x.project_id }; });
              return Promise.all([mem.length ? pick(sb.from('committee_members').insert(mem).select()) : null, prj.length ? pick(sb.from('committee_assigned_projects').insert(prj).select()) : null]);
            }).then(function () { count++; });
        });
        return chain.then(function () { return { success: true, count: count, message: 'คัดลอกสำเร็จ ' + count + ' กลุ่ม' }; });
      });
  };

  // ===== CRITERIA / SCHEDULE =====
  BACKEND.saveCriteria = function (roundId, criteriaData) {
    var cid = 'CRI-' + roundId.toUpperCase() + '-' + Date.now();
    return pick(sb.from('evaluation_criteria').insert({ criteria_id: cid, round_id: roundId, created_at: new Date().toISOString(), max_score_scale: parseInt(criteriaData.max_score_scale, 10) || null }).select())
      .then(function () {
        var items = (criteriaData.items || []).map(function (it, idx) {
          return { criteria_id: cid, item_key: (it.id != null) ? String(it.id) : ('item' + idx), title: it.title != null ? it.title : null, multiplier: it.multiplier != null ? num(it.multiplier) : null, weight: it.weight != null ? num(it.weight) : null };
        });
        if (items.length) return pick(sb.from('evaluation_criteria_items').insert(items).select());
      }).then(function () { return { success: true, message: 'บันทึกเกณฑ์คะแนนเรียบร้อย (New Version)' }; })
      .catch(function (e) { return { success: false, message: String(e.message || e) }; });
  };
  BACKEND.getLatestCriteria = function (roundId) {
    return one(sb.from('evaluation_criteria').select('criteria_id,max_score_scale').eq('round_id', roundId).order('criteria_id', { ascending: false }).limit(1))
      .then(function (crit) {
        if (!crit) return null;
        return pick(sb.from('evaluation_criteria_items').select('item_key,title,multiplier,weight').eq('criteria_id', crit.criteria_id))
          .then(function (items) {
            var mapped = items.map(function (it) { var o = { id: it.item_key, title: it.title }; if (it.multiplier != null) o.multiplier = Number(it.multiplier); if (it.weight != null) o.weight = Number(it.weight); return o; });
            return { criteria_id: crit.criteria_id, max_score_scale: Number(crit.max_score_scale), items: mapped };
          });
      });
  };
  BACKEND.getCriteriaForEvaluation = function (roundId, role) {
    var targetId = (role === 'advisor') ? 'universal_advisor_criteria' : roundId;
    return pick(sb.from('criteria_legacy').select('id,name,weight,description').eq('round_id', targetId))
      .then(function (rows) { return rows.map(function (r) { return { id: r.id, name: r.name, max: parseFloat(r.weight) || 0, description: r.description }; }); });
  };
  BACKEND.saveEvaluationSchedule = function (data) {
    return one(sb.from('evaluation_schedules').select('schedule_id').eq('group_id', data.group_id).limit(1)).then(function (ex) {
      var sid = data.schedule_id || (ex ? ex.schedule_id : ('SCH-' + Date.now()));
      return pick(sb.from('evaluation_schedules').upsert({ schedule_id: sid, group_id: data.group_id, exam_date: String(data.exam_date || ''), exam_time: data.exam_time, venue: data.venue, mode: data.mode, updated_at: new Date().toISOString() }).select());
    }).then(function () { return { success: true, message: 'บันทึกตารางสอบเรียบร้อย' }; })
      .catch(function (e) { return { success: false, message: String(e.message || e) }; });
  };
  BACKEND.getAllSchedules = function () {
    return pick(sb.from('evaluation_schedules').select('schedule_id,group_id,exam_date,exam_time,venue,mode'))
      .then(function (rows) { return rows.map(function (r) { return { schedule_id: r.schedule_id, group_id: r.group_id, exam_date: String(r.exam_date), exam_time: r.exam_time, venue: r.venue, mode: r.mode }; }); });
  };

  // ===== EVALUATION =====
  BACKEND.submitEvaluation = function (payload) {
    var resultId = 'RES-' + new Date().getTime();
    return pick(sb.from('evaluation_results').insert({
      result_id: resultId, round_id: payload.round_id, project_id: payload.project_id,
      evaluator_username: payload.evaluator, evaluator_role: payload.role,
      total_score: num(payload.total_score), full_score: num(payload.full_score), percentage: num(payload.percentage),
      feedback: payload.feedback, timestamp: new Date().toLocaleString('th-TH')
    }).select()).then(function () {
      var scores = payload.scores || {};
      var rows = Object.keys(scores).map(function (k) { return { result_id: resultId, criteria_key: String(k), score: num(scores[k]) }; });
      if (rows.length) return pick(sb.from('evaluation_result_scores').insert(rows).select());
    }).then(function () { return { success: true, message: 'Recorded successfully' }; })
      .catch(function (e) { return { success: false, message: String(e.message || e) }; });
  };

  BACKEND.getEvaluationSummary = function (roundId, year) {
    var ty = String(year || '').trim(), tr = String(roundId || '').trim();
    return Promise.all([
      userInfoMap(),
      pick(sb.from('projects').select('pj_id,name,year,project_members(username),project_advisors(username)').eq('year', ty)),
      pick(sb.from('evaluation_results').select('project_id,evaluator_username,evaluator_role,total_score,full_score').eq('round_id', tr)),
      pick(sb.from('evaluation_committees').select('committee_members(username),committee_assigned_projects(project_id)').eq('round_id', tr).eq('year', ty))
    ]).then(function (a) {
      var userMap = a[0];
      var projects = a[1].map(function (r) {
        return { id: String(r.pj_id).trim(), name: r.name, students: JSON.stringify((r.project_members || []).map(function (x) { return x.username; })), advisors: (r.project_advisors || []).map(function (x) { return x.username; }), year: String(r.year) };
      });
      var results = a[2].map(function (r) {
        var ev = String(r.evaluator_username || '').trim(), info = userMap[ev] || { name: ev, image: '' };
        return { project_id: String(r.project_id || '').trim(), evaluator: ev, evaluator_name: info.name, evaluator_image: info.image, role: r.evaluator_role, score: parseFloat(r.total_score) || 0, full_score: parseFloat(r.full_score) || 0 };
      });
      var committees = {};
      a[3].forEach(function (c) { var members = (c.committee_members || []).map(function (x) { return x.username; }); (c.committee_assigned_projects || []).forEach(function (p) { committees[String(p.project_id).trim()] = members; }); });
      return { projects: projects, results: results, committees: committees };
    });
  };

  BACKEND.getProjectAnalytics = function (projectId) {
    return Promise.all([
      pick(sb.from('evaluation_criteria').select('criteria_id,round_id,max_score_scale').order('criteria_id', { ascending: false })),
      pick(sb.from('evaluation_results').select('round_id,evaluator_role,evaluator_username,total_score,feedback').eq('project_id', projectId))
    ]).then(function (a) {
      var crit = a[0], latest = {};
      crit.forEach(function (c) { var r = String(c.round_id).trim(); if (!latest[r]) latest[r] = c; });
      var roundIds = Object.keys(latest);
      return Promise.all(roundIds.map(function (r) {
        return pick(sb.from('evaluation_criteria_items').select('multiplier').eq('criteria_id', latest[r].criteria_id))
          .then(function (items) { var scale = Number(latest[r].max_score_scale) || 0, tot = 0; items.forEach(function (it) { tot += scale * (parseFloat(it.multiplier) || 1); }); return { r: r, max: tot }; });
      })).then(function (maxes) {
        var maxMap = {}; maxes.forEach(function (m) { maxMap[m.r] = m.max; });
        var rawData = a[1].map(function (row) { return { round: row.round_id, role: row.evaluator_role, evaluator: row.evaluator_username, score: parseFloat(row.total_score) || 0, feedback: row.feedback ? String(row.feedback).trim() : '' }; });
        var summary = {};
        rawData.forEach(function (r) {
          if (!summary[r.round]) summary[r.round] = { commTotal: 0, commCount: 0, advTotal: 0, advCount: 0, feedbacks: [] };
          if (r.role === 'committee') { summary[r.round].commTotal += r.score; summary[r.round].commCount++; }
          else if (r.role === 'advisor') { summary[r.round].advTotal += r.score; summary[r.round].advCount++; }
          if (r.feedback) summary[r.round].feedbacks.push({ text: r.feedback, role: r.role, evaluator: r.evaluator });
        });
        var out = {};
        Object.keys(summary).forEach(function (rid) {
          var s = summary[rid];
          out[rid] = { commScore: s.commCount > 0 ? (s.commTotal / s.commCount).toFixed(2) : '-', advScore: s.advCount > 0 ? (s.advTotal / s.advCount).toFixed(2) : '-', feedbacks: s.feedbacks, maxScore: maxMap[rid] || 0, status: 'evaluated' };
        });
        return out;
      });
    });
  };

  BACKEND.getTeacherEvaluationTasks = function (username) {
    return Promise.all([
      pick(sb.from('evaluation_schedules').select('group_id,exam_date,venue')),
      pick(sb.from('evaluation_results').select('round_id,project_id,evaluator_role').eq('evaluator_username', username)),
      pick(sb.from('projects').select('pj_id,name,project_advisors(username)')),
      pick(sb.from('evaluation_committees').select('id,round_id,year,committee_members(username),committee_assigned_projects(project_id)'))
    ]).then(function (a) {
      var schedules = {}; a[0].forEach(function (s) { schedules[s.group_id] = { exam_date: String(s.exam_date || '').replace(/'/g, ''), venue: s.venue }; });
      var completed = {}; a[1].forEach(function (r) { completed[r.round_id + '_' + r.project_id + '_' + r.evaluator_role] = true; });
      var projectMap = {}; a[2].forEach(function (p) { projectMap[p.pj_id] = { name: p.name, advisors: (p.project_advisors || []).map(function (x) { return x.username; }) }; });
      var committeeTasks = [], advisorTasks = [], today = new Date(); today.setHours(0, 0, 0, 0);
      var ADV = ['proposal', 'progress1', 'progress2'];
      a[3].forEach(function (g) {
        var groupId = g.id, roundId = g.round_id, groupYear = String(g.year);
        var sch = schedules[groupId] || { exam_date: '', venue: '' };
        var overdue = false; if (sch.exam_date) { var ed = new Date(sch.exam_date); overdue = Math.ceil((ed - today) / 86400000) < 0; }
        var members = (g.committee_members || []).map(function (x) { return x.username; });
        var projects = (g.committee_assigned_projects || []).map(function (x) { return x.project_id; });
        if (members.indexOf(username) >= 0) {
          projects.forEach(function (pjId) {
            var done = completed[roundId + '_' + pjId + '_committee'];
            committeeTasks.push({ task_id: 'COM-' + groupId + '-' + pjId, round_id: roundId, project_id: pjId, project_name: (projectMap[pjId] && projectMap[pjId].name) || pjId, exam_date: sch.exam_date, venue: sch.venue || '', status: done ? 'completed' : 'pending', is_overdue: overdue && !done, role: 'committee', year: groupYear });
          });
        }
        if (ADV.indexOf(roundId) >= 0) {
          projects.forEach(function (pjId) {
            var pd = projectMap[pjId];
            if (pd && pd.advisors.indexOf(username) >= 0) {
              var done = completed[roundId + '_' + pjId + '_advisor'];
              advisorTasks.push({ task_id: 'ADV-' + groupId + '-' + pjId, round_id: roundId, project_id: pjId, project_name: pd.name, exam_date: sch.exam_date, venue: sch.venue || '', status: done ? 'completed' : 'pending', is_overdue: overdue && !done, role: 'advisor', year: groupYear });
            }
          });
        }
      });
      return { committee: committeeTasks, advisor: advisorTasks };
    });
  };

  BACKEND.getTeacherProjects = function (username, role) {
    var p1 = pick(sb.from('evaluation_results').select('project_id').eq('evaluator_username', username));
    var p2 = (role === 'committee')
      ? pick(sb.from('evaluation_committees').select('committee_assigned_projects(project_id),committee_members!inner(username)').eq('committee_members.username', username))
      : Promise.resolve([]);
    return Promise.all([p1, p2, pick(sb.from('projects').select('pj_id,category,name,education_level,project_members(username),project_advisors(username)'))]).then(function (a) {
      var evaluated = {}; a[0].forEach(function (r) { evaluated[r.project_id] = true; });
      var myCom = {}; a[1].forEach(function (g) { (g.committee_assigned_projects || []).forEach(function (p) { myCom[p.project_id] = true; }); });
      var out = [];
      a[2].forEach(function (r) {
        var advisors = (r.project_advisors || []).map(function (x) { return x.username; });
        var students = (r.project_members || []).map(function (x) { return x.username; });
        var match = false, status = 'pending';
        if (role === 'advisor') { if (advisors.indexOf(username) >= 0) match = true; }
        else if (role === 'committee') { if (myCom[r.pj_id]) { match = true; status = evaluated[r.pj_id] ? 'evaluated' : 'pending'; } }
        if (match) out.push({ id: r.pj_id, name: r.name, type: r.category, description: r.education_level, status: status, students: students, advisors: advisors });
      });
      return out;
    });
  };

  BACKEND.getStudentDashboardData = function (username) {
    var currentYear = String(new Date().getFullYear() + 543);
    return Promise.all([userInfoMap(), pick(sb.from('project_members').select('project_id').eq('username', username))]).then(function (a) {
      var userMap = a[0], pjIds = a[1].map(function (x) { return x.project_id; });
      var resolve = function (list) { return (list || []).filter(Boolean).map(function (u) { var i = userMap[u] || { name: u, image: '' }; return { username: u, name: i.name, image: i.image }; }); };
      if (!pjIds.length) return { project: null, evaluations: [], schedules: {} };
      return pick(sb.from('projects').select('pj_id,category,name,education_level,year,project_members(username),project_advisors(username)').in('pj_id', pjIds).eq('year', currentYear)).then(function (rows) {
        if (!rows.length) return { project: null, evaluations: [], schedules: {} };
        var r = rows[0];
        var mem = (r.project_members || []).map(function (x) { return x.username; });
        var adv = (r.project_advisors || []).map(function (x) { return x.username; });
        var myProject = { id: r.pj_id, type: r.category, name: r.name, description: r.education_level, year: String(r.year), students: resolve(mem), advisors: resolve(adv), raw_students: mem, raw_advisors: adv };
        return Promise.all([
          pick(sb.from('evaluation_criteria').select('criteria_id,round_id,max_score_scale').order('criteria_id', { ascending: false })),
          pick(sb.from('evaluation_results').select('result_id,round_id,evaluator_role,evaluator_username,total_score,full_score,feedback').eq('project_id', myProject.id)),
          pick(sb.from('evaluation_schedules').select('group_id,exam_date,exam_time,venue')),
          pick(sb.from('evaluation_committees').select('id,round_id,committee_assigned_projects(project_id)'))
        ]).then(function (b) {
          var latest = {}; b[0].forEach(function (c) { var rr = String(c.round_id).trim(); if (!latest[rr]) latest[rr] = c; });
          return Promise.all(Object.keys(latest).map(function (rr) {
            return pick(sb.from('evaluation_criteria_items').select('item_key,title,multiplier').eq('criteria_id', latest[rr].criteria_id)).then(function (items) {
              var im = {}; items.forEach(function (it) { im[it.item_key] = { title: it.title, weight: parseFloat(it.multiplier) || 1 }; });
              return { rr: rr, meta: { max: Number(latest[rr].max_score_scale), itemMap: im } };
            });
          })).then(function (metas) {
            var criteriaMap = {}; metas.forEach(function (m) { criteriaMap[m.rr] = m.meta; });
            var resRows = b[1], scoreMap = {};
            var scoresP = resRows.length ? pick(sb.from('evaluation_result_scores').select('result_id,criteria_key,score').in('result_id', resRows.map(function (x) { return x.result_id; }))) : Promise.resolve([]);
            return scoresP.then(function (scores) {
              scores.forEach(function (s) { if (!scoreMap[s.result_id]) scoreMap[s.result_id] = {}; scoreMap[s.result_id][s.criteria_key] = Number(s.score); });
              var evaluations = resRows.map(function (row) {
                var roundId = String(row.round_id).trim(), role = String(row.evaluator_role).trim().toLowerCase(), ev = String(row.evaluator_username).trim();
                var info = userMap[ev] || { name: ev, image: '' };
                var key = (role === 'advisor') ? 'universal_advisor_criteria' : roundId;
                return { round: roundId, role: row.evaluator_role, evaluator: ev, evaluatorName: info.name, evaluatorImage: info.image, total: parseFloat(row.total_score) || 0, full: parseFloat(row.full_score) || 0, scores_detail: scoreMap[row.result_id] || {}, feedback: row.feedback, criteria_meta: criteriaMap[key] || null };
              });
              var schMap = {}; b[2].forEach(function (s) { schMap[s.group_id] = { date: String(s.exam_date || '').replace(/'/g, ''), time: s.exam_time, venue: s.venue }; });
              var schedules = {}; b[3].forEach(function (g) { var pjs = (g.committee_assigned_projects || []).map(function (x) { return x.project_id; }); if (pjs.indexOf(myProject.id) >= 0 && schMap[g.id]) schedules[g.round_id] = schMap[g.id]; });
              return { project: myProject, evaluations: evaluations, schedules: schedules };
            });
          });
        });
      });
    });
  };

  // ===== FILES =====
  BACKEND.getProjectFiles = function (projectId) {
    return pick(sb.from('project_files').select('file_type,file_ext,file_name,file_url,uploaded_by,timestamp').eq('project_id', projectId))
      .then(function (rows) { return rows.map(function (r) { return { type: r.file_type, ext: r.file_ext, name: r.file_name, url: r.file_url, uploaded_by: r.uploaded_by, timestamp: r.timestamp }; }); });
  };
  BACKEND.getAdminFileRepositoryData = function () {
    return Promise.all([
      pick(sb.from('projects').select('pj_id,category,name,education_level,year')),
      pick(sb.from('project_files').select('project_id,file_type,file_ext,file_name,file_url,uploaded_by,timestamp'))
    ]).then(function (a) {
      var fileMap = {}; a[1].forEach(function (r) { var pid = String(r.project_id); if (!fileMap[pid]) fileMap[pid] = []; fileMap[pid].push({ type: r.file_type, ext: r.file_ext, name: r.file_name, url: r.file_url, uploaded_by: r.uploaded_by, timestamp: r.timestamp }); });
      return a[0].map(function (r) { return { id: r.pj_id, type: r.category, name: r.name, level: r.education_level, year: String(r.year), files: fileMap[r.pj_id] || [] }; });
    });
  };

  // ===== REQUESTS =====
  BACKEND.submitProjectEditRequest = function (payload) {
    return pick(sb.from('project_requests').insert({ request_id: 'REQ-' + new Date().getTime(), project_id: payload.id, new_data: { name: payload.name, type: payload.type, description: payload.description, students: payload.students, advisors: payload.advisors }, requested_by: payload.requested_by, status: 'pending', timestamp: new Date().toLocaleString('th-TH') }).select())
      .then(function () { return { success: true, message: 'ส่งคำร้องขอแก้ไขเรียบร้อย รอครูอนุมัติ' }; })
      .catch(function (e) { return { success: false, message: String(e.message || e) }; });
  };
  BACKEND.getPendingEditRequests = function (userRole, username) {
    var norm = function (id) { if (!id) return ''; var s = String(id).trim().toLowerCase(); return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s; };
    return Promise.all([
      pick(sb.from('user_profiles').select('username,prefix,firstname,lastname')),
      pick(sb.from('projects').select('pj_id,category,name,education_level,project_members(username),project_advisors(username)')),
      pick(sb.from('project_requests').select('request_id,project_id,new_data,requested_by,timestamp').eq('status', 'pending').order('request_id', { ascending: false }))
    ]).then(function (a) {
      var userMap = {}; a[0].forEach(function (u) { userMap[norm(u.username)] = ((u.prefix || '') + (u.firstname || '') + ' ' + (u.lastname || '')).trim() || String(u.username); });
      var projectMap = {}; a[1].forEach(function (p) {
        var members = (p.project_members || []).map(function (x) { return x.username; });
        var advisors = (p.project_advisors || []).map(function (x) { return x.username; });
        projectMap[String(p.pj_id).trim()] = { name: p.name, current_data: { name: p.name, type: p.category, description: p.education_level, students: JSON.stringify(members), advisors: JSON.stringify(advisors) }, advisors: advisors };
      });
      var out = [];
      a[2].forEach(function (req) {
        var pjId = String(req.project_id).trim(), project = projectMap[pjId]; if (!project) return;
        var visible = false;
        if (userRole === 'admin') visible = true;
        else if (userRole === 'teacher') { if (project.advisors.indexOf(String(username).trim()) >= 0) visible = true; }
        if (!visible) return;
        var raw = String(req.requested_by).trim();
        out.push({ request_id: req.request_id, project_id: pjId, project_name: project.name, requested_by: raw, requester_name: userMap[norm(raw)] || raw, timestamp: req.timestamp, current_data: project.current_data, new_data: req.new_data });
      });
      return out;
    });
  };
  BACKEND.processEditRequest = function (requestId, action, approver) {
    return one(sb.from('project_requests').select('request_id,project_id,new_data,status').eq('request_id', requestId).limit(1)).then(function (req) {
      if (!req) return { success: false, message: 'ไม่พบรายการคำร้อง' };
      if (req.status !== 'pending') return { success: false, message: 'คำร้องนี้ถูกดำเนินการไปแล้ว' };
      if (action === 'reject') return pick(sb.from('project_requests').update({ status: 'rejected' }).eq('request_id', requestId).select()).then(function () { return { success: true, message: 'ปฏิเสธคำร้องเรียบร้อย' }; });
      if (action === 'approve') {
        var nd = req.new_data || {}, pjId = req.project_id;
        return pick(sb.from('projects').update({ category: nd.type, name: nd.name, education_level: nd.description }).eq('pj_id', pjId).select())
          .then(function () { return pick(sb.from('project_members').delete().eq('project_id', pjId).select()); })
          .then(function () { return pick(sb.from('project_advisors').delete().eq('project_id', pjId).select()); })
          .then(function () { return projectLinks(pjId, nd.students, nd.advisors); })
          .then(function () { return pick(sb.from('project_requests').update({ status: 'approved' }).eq('request_id', requestId).select()); })
          .then(function () { return { success: true, message: 'อนุมัติและอัปเดตข้อมูลเรียบร้อย' }; });
      }
    });
  };

  // ===== DASHBOARD =====
  BACKEND.getDashboardStats = function (year) {
    return Promise.all([
      pick(sb.from('projects').select('pj_id,category,education_level,year').eq('year', year)),
      pick(sb.from('evaluation_results').select('project_id,round_id')),
      pick(sb.from('users').select('role'))
    ]).then(function (a) {
      var projects = a[0].map(function (r) { return { id: r.pj_id, category: r.category, level: r.education_level, year: String(r.year) }; });
      var passed = {}; a[1].forEach(function (r) { if (!passed[r.project_id]) passed[r.project_id] = {}; passed[r.project_id][r.round_id] = 1; });
      var passedMap = {}; Object.keys(passed).forEach(function (k) { passedMap[k] = Object.keys(passed[k]); });
      var uc = { student: 0, teacher: 0 }; a[2].forEach(function (u) { var role = String(u.role || 'student').toLowerCase(); if (role === 'teacher' || role === 'admin') uc.teacher++; else uc.student++; });
      return { projects: projects, passedMap: passedMap, userCounts: uc };
    });
  };

  // ===== AWARDS =====
  BACKEND.saveAward = function (data) {
    if (!data.project_id || !data.award_name) return Promise.resolve({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    var ts = new Date().toLocaleString('th-TH');
    var pre = data.award_id ? one(sb.from('project_awards').select('student_username').eq('award_id', data.award_id).limit(1)) : Promise.resolve(null);
    return pre.then(function (ex) {
      if (data.award_id && ex && ex.student_username !== data.student_username) throw new Error('ไม่มีสิทธิ์แก้ไข');
      var awardId = data.award_id || ('AWD-' + Date.now());
      return pick(sb.from('project_awards').upsert({ award_id: awardId, project_id: data.project_id, project_name: data.project_name, student_username: data.student_username, award_name: data.award_name, award_level: data.award_level, organization: data.organization, received_date: String(data.received_date || ''), cert_file_id: data.cert_file_id, cert_file_type: data.cert_file_type, status: 'pending', feedback: '', timestamp: ts }).select())
        .then(function () { return pick(sb.from('award_photos').delete().eq('award_id', awardId).select()); })
        .then(function () { return pick(sb.from('award_hashtags').delete().eq('award_id', awardId).select()); })
        .then(function () {
          var photos = (data.team_photos || []).map(function (fid, idx) { return { award_id: awardId, sort_order: idx, file_id: String(fid) }; });
          var tags = dedupeLinks(data.hashtags, 'award_id', awardId, 'hashtag');
          return Promise.all([photos.length ? pick(sb.from('award_photos').insert(photos).select()) : null, tags.length ? pick(sb.from('award_hashtags').insert(tags).select()) : null]);
        }).then(function () { return { success: true, message: 'บันทึกข้อมูลรางวัลเรียบร้อย', award_id: awardId }; });
    }).catch(function (e) { return { success: false, message: 'Error: ' + (e.message || e) }; });
  };
  BACKEND.deleteAward = function (awardId, username) {
    return one(sb.from('project_awards').select('student_username,status').eq('award_id', awardId).limit(1)).then(function (a) {
      if (!a) return { success: false, message: 'ไม่พบข้อมูล' };
      if (a.student_username !== username) return { success: false, message: 'ไม่มีสิทธิ์ลบ' };
      if (a.status === 'approved') return { success: false, message: 'รายการนี้อนุมัติแล้ว ลบไม่ได้' };
      return pick(sb.from('project_awards').delete().eq('award_id', awardId).select()).then(function () { return { success: true, message: 'ลบรายการเรียบร้อย' }; });
    });
  };
  BACKEND.getHashtags = function () {
    return pick(sb.from('award_hashtags').select('hashtag')).then(function (rows) {
      var m = {}; rows.forEach(function (r) { var t = String(r.hashtag || '').trim(); if (t) m[t] = (m[t] || 0) + 1; });
      return Object.keys(m).map(function (t) { return { text: t, count: m[t] }; }).sort(function (x, y) { return y.count - x.count; });
    });
  };
  BACKEND.getAwards = function (mode, key) {
    var q = sb.from('project_awards').select('*,award_photos(sort_order,file_id),award_hashtags(hashtag)');
    if (mode === 'student') q = q.eq('student_username', key);
    else if (mode === 'project') q = q.eq('project_id', key).eq('status', 'approved');
    else if (mode === 'all') q = q.eq('status', 'approved');
    else if (mode === 'pending') q = q.eq('status', 'pending');
    return pick(q.order('award_id', { ascending: true })).then(function (rows) {
      return rows.map(function (row) {
        var photos = (row.award_photos || []).slice().sort(function (a, b) { return a.sort_order - b.sort_order; }).map(function (p) { return p.file_id; });
        var tags = (row.award_hashtags || []).map(function (h) { return h.hashtag; });
        return { award_id: row.award_id, project_id: row.project_id, project_name: row.project_name, student_username: row.student_username, award_name: row.award_name, award_level: row.award_level, organization: row.organization, received_date: row.received_date, cert_file_id: row.cert_file_id, cert_file_type: row.cert_file_type, team_photos: photos, hashtags: tags, status: row.status, feedback: row.feedback, timestamp: row.timestamp };
      }).reverse();
    });
  };
  BACKEND.processAwardRequest = function (awardId, action, feedback) {
    return one(sb.from('project_awards').select('award_id').eq('award_id', awardId).limit(1)).then(function (a) {
      if (!a) return { success: false, message: 'ไม่พบรายการ' };
      if (action === 'approve') return pick(sb.from('project_awards').update({ status: 'approved', feedback: '' }).eq('award_id', awardId).select()).then(function () { return { success: true, message: 'อนุมัติรางวัลเรียบร้อย' }; });
      if (action === 'reject') return pick(sb.from('project_awards').update({ status: 'rejected', feedback: feedback || 'ข้อมูลไม่ถูกต้อง' }).eq('award_id', awardId).select()).then(function () { return { success: true, message: 'ส่งกลับแก้ไขเรียบร้อย' }; });
      return { success: false, message: 'ไม่พบรายการ' };
    });
  };
  BACKEND.getPendingAwardCount = function (userRole, username) {
    return BACKEND.getAwards('pending', null).then(function (awards) {
      if (userRole === 'admin') return awards.length;
      if (userRole === 'teacher') return BACKEND.getProjectsByAdvisor(username).then(function (mp) { var ids = mp.map(function (p) { return p.id; }); return awards.filter(function (a) { return ids.indexOf(a.project_id) >= 0; }).length; });
      return 0;
    });
  };

  // ===== SOCIAL =====
  BACKEND.savePost = function (payload) {
    var postId = 'POST_' + new Date().getTime();
    var fc; try { fc = (typeof payload.form_config === 'string') ? JSON.parse(payload.form_config || '[]') : (payload.form_config || []); } catch (e) { fc = []; }
    return pick(sb.from('posts').insert({ post_id: postId, type: payload.type, title: payload.title, subtitle: payload.subtitle || '', organization: payload.organization || '', level: payload.level || '', content: payload.content, form_config: fc, status: 'active', timestamp: _now(), author: 'admin' }).select())
      .then(function () {
        var imgs = (payload.images || []).map(function (u, i) { return { post_id: postId, sort_order: i, image_url: String(u) }; });
        var tags = dedupeLinks(payload.hashtags, 'post_id', postId, 'hashtag');
        return Promise.all([imgs.length ? pick(sb.from('post_images').insert(imgs).select()) : null, tags.length ? pick(sb.from('post_hashtags').insert(tags).select()) : null]);
      }).then(function () { return { success: true, message: 'บันทึกโพสต์เรียบร้อย', postId: postId }; })
      .catch(function (e) { return { success: false, message: String(e.message || e) }; });
  };
  BACKEND.getPosts = function (typeFilter) {
    var q = sb.from('posts').select('*,post_images(sort_order,image_url),post_hashtags(hashtag)').eq('status', 'active').order('post_id', { ascending: true });
    if (typeFilter && typeFilter !== 'all') q = q.eq('type', typeFilter);
    return pick(q).then(function (rows) {
      return rows.map(function (row) {
        var images = (row.post_images || []).slice().sort(function (a, b) { return a.sort_order - b.sort_order; }).map(function (x) { return x.image_url; });
        var hashtags = (row.post_hashtags || []).map(function (x) { return x.hashtag; });
        return { post_id: row.post_id, type: row.type, title: row.title, subtitle: row.subtitle, organization: row.organization, level: row.level, content: row.content, images: images, hashtags: hashtags, form_config: row.form_config || [], status: row.status, timestamp: row.timestamp, author: row.author };
      }).reverse();
    });
  };
  BACKEND.deletePost = function (postId) {
    return pick(sb.from('posts').update({ status: 'deleted' }).eq('post_id', postId).select()).then(function (d) { return (d && d.length) ? { success: true } : { success: false, message: 'Post not found' }; });
  };
  BACKEND.updatePost = function (payload) {
    return pick(sb.from('posts').update({ title: payload.title, subtitle: payload.subtitle || '', organization: payload.organization || '', level: payload.level || '', content: payload.content }).eq('post_id', payload.post_id).select())
      .then(function (d) {
        if (!d || !d.length) return { success: false, message: 'Post not found' };
        return pick(sb.from('post_images').delete().eq('post_id', payload.post_id).select())
          .then(function () { return pick(sb.from('post_hashtags').delete().eq('post_id', payload.post_id).select()); })
          .then(function () {
            var imgs = (payload.images || []).map(function (u, i) { return { post_id: payload.post_id, sort_order: i, image_url: String(u) }; });
            var tags = dedupeLinks(payload.hashtags, 'post_id', payload.post_id, 'hashtag');
            return Promise.all([imgs.length ? pick(sb.from('post_images').insert(imgs).select()) : null, tags.length ? pick(sb.from('post_hashtags').insert(tags).select()) : null]);
          }).then(function () { return { success: true }; });
      });
  };
  BACKEND.getPostRegistrations = function (postId) {
    return pick(sb.from('post_registrations').select('reg_id,username,form_data,timestamp').eq('post_id', postId))
      .then(function (rows) { return rows.map(function (r) { return { reg_id: r.reg_id, student: r.username, data: r.form_data || {}, timestamp: r.timestamp }; }); });
  };
  BACKEND.toggleLike = function (postId, username) {
    return one(sb.from('post_likes').select('post_id').eq('post_id', postId).eq('username', username).limit(1)).then(function (ex) {
      if (ex) return pick(sb.from('post_likes').delete().eq('post_id', postId).eq('username', username).select()).then(function () { return { status: 'unliked' }; });
      return pick(sb.from('post_likes').insert({ post_id: postId, username: username, timestamp: new Date().toISOString() }).select()).then(function () { return { status: 'liked' }; });
    });
  };
  BACKEND.addComment = function (postId, username, text) {
    var id = 'CMT_' + new Date().getTime(), time = _now('dd/MM/yyyy HH:mm');
    return pick(sb.from('post_comments').insert({ comment_id: id, post_id: postId, username: username, text: text, timestamp: time }).select())
      .then(function () { return { success: true, comment: { id: id, username: username, text: text, time: time } }; });
  };
  BACKEND.getSocialData = function (postIds) {
    return Promise.all([pick(sb.from('post_likes').select('post_id,username')), pick(sb.from('post_comments').select('comment_id,post_id,username,text,timestamp').order('comment_id', { ascending: true }))]).then(function (a) {
      var likeMap = {}; a[0].forEach(function (r) { if (!likeMap[r.post_id]) likeMap[r.post_id] = []; likeMap[r.post_id].push(r.username); });
      var cmtMap = {}; a[1].forEach(function (r) { if (!cmtMap[r.post_id]) cmtMap[r.post_id] = []; cmtMap[r.post_id].push({ id: r.comment_id, username: r.username, text: r.text, timestamp: r.timestamp }); });
      return { likes: likeMap, comments: cmtMap };
    });
  };
  BACKEND.submitRegistration = function (postId, username, formDataJson) {
    var id = 'REG_' + new Date().getTime(), time = _now('dd/MM/yyyy HH:mm'), fd;
    try { fd = (typeof formDataJson === 'string') ? JSON.parse(formDataJson) : formDataJson; } catch (e) { fd = formDataJson; }
    return pick(sb.from('post_registrations').insert({ reg_id: id, post_id: postId, username: username, form_data: fd, timestamp: time }).select()).then(function () { return { success: true }; });
  };

  // ===== ADMIN USER MGMT =====  (เปลี่ยนรหัสผ่านต้องผ่าน GAS — ดูหมายเหตุท้ายไฟล์)
  BACKEND.getTeacherListForLogin = function () {
    return Promise.all([pick(sb.from('user_profiles').select('username,prefix,firstname,lastname')), pick(sb.from('users').select('username,role'))]).then(function (a) {
      var nameMap = {}; a[0].forEach(function (u) { nameMap[u.username] = ((u.prefix || '') + (u.firstname || '') + ' ' + (u.lastname || '')).trim(); });
      var out = [];
      a[1].forEach(function (u) { var role = String(u.role || '').toLowerCase(); if (role === 'admin' || role === 'teacher') { var n = nameMap[u.username]; out.push({ username: u.username, name: (n && n !== '') ? n : u.username }); } });
      return out;
    });
  };
  BACKEND.getAdminAllUsers = function () {
    return Promise.all([pick(sb.from('user_profiles').select('username,picture_url,classroom,number,prefix,firstname,lastname')), pick(sb.from('users').select('username,role'))]).then(function (a) {
      var dm = {}; a[0].forEach(function (r) { dm[r.username] = { image: r.picture_url, classroom: r.classroom, number: r.number, prefix: r.prefix, firstname: r.firstname, lastname: r.lastname, fullname: ((r.prefix || '') + (r.firstname || '') + ' ' + (r.lastname || '')).trim() }; });
      var out = [];
      a[1].forEach(function (u) { if (u.username === 'admin') return; var info = dm[u.username] || {}; out.push(Object.assign({ username: u.username, password: '', role: u.role || 'student' }, info)); });
      return out;
    });
  };
  BACKEND.saveAdminUser = function (data) {
    var username = String(data.username).trim();
    if (!username) return Promise.resolve({ success: false, message: 'ต้องระบุ Username' });
    return one(sb.from('users').select('username').eq('username', username).limit(1)).then(function (ex) {
      var isNew = !ex;
      return pick(sb.from('users').upsert({ username: username, role: data.role }).select())
        .then(function () { return pick(sb.from('user_profiles').upsert({ username: username, picture_url: data.image || '', classroom: data.classroom || '', number: data.number || '', prefix: data.prefix || '', firstname: data.firstname || '', lastname: data.lastname || '' }).select()); })
        .then(function () { if (data.password || isNew) return gasCall('__setpw__', { callerToken: currentToken, username: username, password: data.password || username }); })
        .then(function () { return { success: true, message: 'บันทึกข้อมูลเรียบร้อย' }; });
    });
  };
  BACKEND.deleteAdminUser = function (username) {
    return pick(sb.from('users').delete().eq('username', username).select()).then(function () { return { success: true }; });
  };
  BACKEND.promoteStudents = function () {
    return pick(sb.from('user_profiles').select('username,classroom')).then(function (profs) {
      var chain = Promise.resolve(), count = 0;
      profs.forEach(function (p) {
        var cls = String(p.classroom || ''); if (!cls) return;
        var m = cls.match(/^(\d+)(\/.*)?$/) || cls.match(/^ม\.(\d+)(\/.*)?$/); if (!m) return;
        var lvl = parseInt(m[1]), suf = m[2] || '', ncs = null;
        if (lvl < 6) ncs = cls.indexOf('ม.') >= 0 ? ('ม.' + (lvl + 1) + suf) : ('' + (lvl + 1) + suf);
        else if (lvl === 6) ncs = 'จบ' + (new Date().getFullYear() + 543);
        if (ncs !== null) { chain = chain.then(function () { return pick(sb.from('user_profiles').update({ classroom: ncs }).eq('username', p.username).select()); }).then(function () { count++; }); }
      });
      return chain.then(function () { return { success: true, count: count, message: 'เลื่อนระดับชั้นสำเร็จ ' + count + ' คน' }; });
    });
  };
  BACKEND.batchImportUsers = function (users) {
    return pick(sb.from('users').select('username')).then(function (ex) {
      var exist = {}; ex.forEach(function (u) { exist[String(u.username).trim()] = 1; });
      var authRows = [], detailRows = [], pwds = [], skipped = 0;
      users.forEach(function (u) {
        var un = String(u.username).trim(); if (!un || exist[un]) { skipped++; return; } exist[un] = 1;
        authRows.push({ username: un, role: u.role || 'student' });
        pwds.push({ username: un, password: u.password ? String(u.password).trim() : un });
        detailRows.push({ username: un, picture_url: '', classroom: u.classroom || '', number: u.number || '', prefix: u.prefix || '', firstname: u.firstname || '', lastname: u.lastname || '' });
      });
      if (!authRows.length) return { success: true, imported: 0, skipped: skipped, message: 'นำเข้าสำเร็จ 0 รายการ (ข้าม ' + skipped + ' รายการที่ซ้ำ)' };
      return pick(sb.from('users').insert(authRows).select())
        .then(function () { return pick(sb.from('user_profiles').insert(detailRows).select()); })
        .then(function () { return gasCall('__setpw_bulk__', { callerToken: currentToken, passwords: pwds }); })
        .then(function () { return { success: true, imported: authRows.length, skipped: skipped, message: 'นำเข้าสำเร็จ ' + authRows.length + ' รายการ (ข้าม ' + skipped + ' รายการที่ซ้ำ)' }; });
    });
  };

  // ===== utils =====
  function _now(fmt) {
    // คืน timestamp string แบบง่าย (ใช้กับโพสต์/คอมเมนต์) — เลียนแบบรูปแบบเดิมพอประมาณ
    var d = new Date();
    var p = function (n) { return ('0' + n).slice(-2); };
    if (fmt === 'dd/MM/yyyy HH:mm') return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // -------------------------------------------------------------------------
  // shim google.script.run → BACKEND (โค้ด component เดิมไม่ต้องแก้)
  // -------------------------------------------------------------------------
  function makeRunner(success, failure) {
    var runner = {
      withSuccessHandler: function (fn) { return makeRunner(fn, failure); },
      withFailureHandler: function (fn) { return makeRunner(success, fn); }
    };
    return new Proxy(runner, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        return function () {
          var args = Array.prototype.slice.call(arguments);
          Promise.resolve().then(function () {
            var fn = BACKEND[prop];
            if (!fn) throw new Error('ไม่มีฟังก์ชัน backend: ' + String(prop));
            return fn.apply(null, args);
          }).then(function (res) { if (success) success(res); })
            .catch(function (err) {
              console.error('[backend]', String(prop), err);
              if (failure) failure(err);
            });
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);

  console.log('[supabase-api] พร้อมใช้งาน — เชื่อม Supabase + shim google.script.run แล้ว');
})();

/**
 * หมายเหตุ "เปลี่ยนรหัสผ่าน" (updateUserProfile.newPassword, saveAdminUser, batchImportUsers):
 * รหัสผ่าน hash อยู่ใน Postgres และ set ผ่าน RPC ที่เปิดสิทธิ์เฉพาะ service_role
 * → frontend (anon) เรียกตรงไม่ได้ ต้องผ่าน GAS Web App
 * ในไฟล์นี้เรียก gasCall('__setpw__'/'__setpw_bulk__') ไว้เป็น placeholder —
 * ให้เพิ่ม action เหล่านี้ใน webapp.gs (เรียก set_user_password) เมื่อต้องใช้ฟีเจอร์นี้
 */
