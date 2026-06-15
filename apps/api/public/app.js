const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      el.hidden = true;
    },
    isError ? 6000 : 2500
  );
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    ...options
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = (data.error?.details ?? []).map((d) => `${d.field}: ${d.message}`).join(', ');
    throw new Error(`${data.error?.message ?? 'API error'}${details ? ` (${details})` : ''}`);
  }
  return data;
}

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (value) => (value ? new Date(value).toLocaleString('ja-JP') : '-');
const fmtNum = (value) => (value == null ? '-' : Number(value).toLocaleString());
const statusBadge = (status) => {
  const tone =
    {
      processed: 'ok',
      succeeded: 'ok',
      active: 'ok',
      failed: 'error',
      cancelled: 'error',
      conflict: 'warn',
      pending: 'warn',
      retrying: 'warn'
    }[status] ?? 'muted';
  return `<span class="badge ${tone}">${esc(status)}</span>`;
};

// ---------- tabs ----------
const loaders = {
  search: () => {},
  persons: loadPersonsTab,
  sources: loadSourcesTab,
  jobs: loadJobs,
  schemas: loadSchemas,
  candidates: loadCandidates,
  system: loadSystem
};

$('#tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;
  for (const b of $$('#tabs button')) b.classList.toggle('active', b === button);
  for (const panel of $$('.tab-panel')) panel.classList.toggle('active', panel.id === `tab-${button.dataset.tab}`);
  Promise.resolve(loaders[button.dataset.tab]?.()).catch((error) => toast(error.message, true));
});

// ---------- search ----------
$('#searchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = new FormData(event.currentTarget).get('query')?.toString().trim();
  if (!query) return;
  try {
    const data = await api('/v1/search/persons', { method: 'POST', body: JSON.stringify({ query }) });
    renderSearch(data);
  } catch (error) {
    toast(error.message, true);
  }
});

$('#parseOnlyButton').addEventListener('click', async () => {
  const query = $('#searchForm input[name="query"]').value.trim();
  if (!query) return;
  try {
    const data = await api('/v1/search/parse', { method: 'POST', body: JSON.stringify({ query }) });
    $('#dslDetails').open = true;
    $('#dslPreview').textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    toast(error.message, true);
  }
});

function renderSearch(data) {
  $('#dslPreview').textContent = JSON.stringify({ parser: data.parser, fusion_weights: data.fusion_weights, dsl: data.dsl }, null, 2);
  const warnings = data.warnings ?? [];
  $('#searchWarnings').hidden = warnings.length === 0;
  $('#searchWarnings').textContent = warnings.join(' / ');
  const container = $('#searchResults');
  if (!data.results.length) {
    container.innerHTML = '<div class="card"><p class="meta">該当する人物が見つかりませんでした。</p></div>';
    return;
  }
  container.innerHTML = data.results
    .map((result) => {
      const parts = Object.entries(result.score_parts ?? {})
        .map(([key, value]) => `${key} ${(value ?? 0).toFixed(2)}`)
        .join(' / ');
      const reasons = result.matched_reasons.map((reason) => `<span class="badge">${esc(reason)}</span>`).join('');
      const contexts = (result.matched_contexts ?? [])
        .map(
          (context) => `<div class="evidence">
            <strong>${esc(context.title || '(タイトルなし)')}</strong>
            <span class="meta">${fmtDate(context.occurred_at)} / ${esc(context.role ?? '')} / ${esc(context.sentiment ?? '')}</span>
            ${esc(context.evidence_text ?? '')}
          </div>`
        )
        .join('');
      const summary = result.person.summaries?.find((s) => s.summary_type === 'overall');
      return `<article class="card">
        <div class="item-head">
          <h3>${esc(result.display_name)}</h3>
          <span class="score">score ${result.score.toFixed(3)}</span>
        </div>
        <p class="meta">${esc(result.person.person_type ?? '')} ・ ${parts}</p>
        <div>${reasons}</div>
        <p>${esc(result.person.profile?.short_bio ?? summary?.summary_text?.slice(0, 160) ?? '')}</p>
        ${contexts || '<p class="meta">根拠コンテキストはまだありません。</p>'}
      </article>`;
    })
    .join('');
}

// ---------- persons ----------
async function loadPersonsTab() {
  await Promise.all([loadPersonList(), fillTargetPersons()]);
}

async function loadPersonList() {
  const q = $('#personSearchInput').value.trim();
  const data = await api(`/v1/persons?limit=30${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const container = $('#personList');
  container.innerHTML = data.results.length
    ? data.results
        .map((person) => {
          const sns = (person.sns_accounts ?? [])
            .map(
              (account) =>
                `${esc(account.platform)} @${esc(account.handle ?? '')}${account.latest_metric?.follower_count != null ? ` (${fmtNum(account.latest_metric.follower_count)})` : ''}`
            )
            .join(' / ');
          return `<div class="item clickable" data-person-id="${person.id}">
            <div class="item-head"><h3>${esc(person.display_name ?? person.canonical_name)}</h3>${statusBadge(person.status)}</div>
            <p class="meta">${esc(person.person_type ?? '-')} ・ ${sns || 'SNS未登録'}</p>
            <span class="mono">${person.id}</span>
          </div>`;
        })
        .join('')
    : '<p class="meta">人物がまだありません。</p>';
}

let personSearchTimer = null;
$('#personSearchInput').addEventListener('input', () => {
  clearTimeout(personSearchTimer);
  personSearchTimer = setTimeout(() => loadPersonList().catch((error) => toast(error.message, true)), 300);
});

$('#personList').addEventListener('click', (event) => {
  const item = event.target.closest('[data-person-id]');
  if (item) showPersonDetail(item.dataset.personId).catch((error) => toast(error.message, true));
});

const PERSON_TYPES = [
  'actor',
  'politician',
  'athlete',
  'researcher',
  'creator',
  'influencer',
  'executive',
  'journalist',
  'expert',
  'artist',
  'musician',
  'entrepreneur',
  'public_figure',
  'group',
  'other'
];
const RELATIONSHIP_TYPES = ['member_of', 'affiliated_with', 'colleague', 'collaborator', 'family', 'manager', 'co_appeared', 'other'];
const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed', 'unknown'];
// Common SNS platforms / context roles. Open sets stored as free text; these are
// the suggested values shown in dropdowns (add a value here to offer a new one).
const SNS_PLATFORMS = [
  'instagram',
  'x',
  'tiktok',
  'youtube',
  'facebook',
  'threads',
  'linkedin',
  'note',
  'line',
  'github',
  'website',
  'other'
];
const CONTEXT_ROLES = [
  'main_subject',
  'actor',
  'speaker',
  'target',
  'mentioned_only',
  'related_person',
  'author',
  'critic',
  'criticized',
  'winner',
  'nominee',
  'victim',
  'suspect',
  'unknown'
];
const optionsHtml = (values, current) => values.map((v) => `<option ${current === v ? 'selected' : ''}>${v}</option>`).join('');

async function showPersonDetail(personId) {
  const [person, fieldDefs, relationships, allPersons] = await Promise.all([
    api(`/v1/persons/${personId}`),
    listFieldDefinitions(),
    api(`/v1/persons/${personId}/relationships`),
    api('/v1/persons?limit=100')
  ]);
  const panel = $('#personDetail');
  panel.hidden = false;

  const personOptions = allPersons.results
    .filter((p) => p.id !== personId)
    .map((p) => `<option value="${p.id}">${esc(p.display_name ?? p.canonical_name)}</option>`)
    .join('');
  const typeOptions = optionsHtml(PERSON_TYPES, person.person_type);

  const aliases = person.aliases
    .map(
      (alias) => `<span class="badge muted">${esc(alias.alias)}
        <button type="button" class="chip-x" data-action="alias-delete" data-alias-id="${alias.id}" title="別名を削除">×</button></span>`
    )
    .join('');

  const sns = person.sns_accounts
    .map(
      (account) => `<li data-account-id="${account.id}">
        ${esc(account.platform)} @${esc(account.handle ?? '')} — followers ${fmtNum(account.latest_metric?.follower_count)}
        <span class="meta">(${fmtDate(account.latest_metric?.measured_at)}) ${esc(account.status)}</span>
        <button type="button" class="ghost small" data-action="sns-edit-toggle" data-account-id="${account.id}">編集</button>
        <button type="button" class="danger small" data-action="sns-delete" data-account-id="${account.id}">削除</button>
        <form class="inline-edit" data-sns-form="${account.id}" hidden>
          <input name="handle" value="${esc(account.handle ?? '')}" placeholder="handle" />
          <input name="url" value="${esc(account.url ?? '')}" placeholder="URL" />
          <select name="status">${['active', 'inactive', 'deleted', 'private', 'unknown'].map((s) => `<option ${account.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <button type="submit" class="small">保存</button>
        </form>
      </li>`
    )
    .join('');

  const contexts = person.recent_contexts
    .map((context) => {
      const edited = context.metadata?.manually_edited ? '<span class="badge warn">手動編集済</span>' : '';
      return `<div class="evidence" data-context-id="${context.id}">
        <div>${esc((context.context_text ?? '').slice(0, 220))}</div>
        <span class="meta">${fmtDate(context.occurred_at)} / ${esc(context.role ?? '')} / ${(context.context_tags ?? []).map(esc).join(', ')} ${edited}</span>
        <div class="row-gap context-actions">
          <button type="button" class="ghost small" data-action="context-edit-toggle" data-context-id="${context.id}">編集</button>
          <select class="slim" data-reassign-select="${context.id}"><option value="">付け替え先...</option>${personOptions}</select>
          <button type="button" class="ghost small" data-action="context-reassign" data-context-id="${context.id}">付け替え</button>
          <button type="button" class="danger small" data-action="context-delete" data-context-id="${context.id}">削除</button>
        </div>
        <form class="inline-edit" data-context-form="${context.id}" hidden>
          <textarea name="context_text" rows="3">${esc(context.context_text ?? '')}</textarea>
          <input name="context_tags" value="${esc((context.context_tags ?? []).join(', '))}" placeholder="タグ（カンマ区切り）" />
          <label>役割<select name="role">${optionsHtml(CONTEXT_ROLES, context.role)}</select></label>
          <label>感情<select name="sentiment">${optionsHtml(SENTIMENTS, context.sentiment)}</select></label>
          <button type="submit" class="small">保存</button>
        </form>
      </div>`;
    })
    .join('');

  const relationshipList = relationships.results
    .map((rel) => {
      const role = rel.metadata?.role ? `（${esc(rel.metadata.role)}）` : '';
      const label =
        rel.direction === 'outgoing'
          ? `${esc(rel.relationship_type)} → ${esc(rel.other_person_name ?? '?')}${role}`
          : `${esc(rel.other_person_name ?? '?')}${role} → ${esc(rel.relationship_type)}`;
      return `<li>${label}
        <button type="button" class="danger small" data-action="relationship-delete" data-relationship-id="${rel.id}">削除</button></li>`;
    })
    .join('');

  const summaries = person.summaries
    .map(
      (summary) => `<div class="evidence"><strong>${esc(summary.summary_type)}</strong> ${esc(summary.summary_text.slice(0, 240))}</div>`
    )
    .join('');
  const fields = person.fields
    .map(
      (field) =>
        `<dt>${esc(field.field_label)}</dt><dd>${esc(JSON.stringify(field.value))}${field.confidence != null ? ` <span class="meta">conf ${field.confidence}</span>` : ''}</dd>`
    )
    .join('');
  const fieldOptions = fieldDefs.map((def) => `<option value="${esc(def.key)}">${esc(def.label)} (${esc(def.type)})</option>`).join('');

  panel.innerHTML = `
    <div class="item-head"><h2>${esc(person.display_name ?? person.canonical_name)}</h2>
      <div class="row-gap">
        <button type="button" class="ghost small" data-action="person-edit-toggle">基本情報を編集</button>
        <button type="button" class="ghost small" id="personDetailClose">閉じる</button>
      </div>
    </div>
    <p class="meta">${esc(person.person_type ?? '-')} ・ ${statusBadge(person.status)} ・ <span class="mono">${person.id}</span></p>
    <form id="personEditForm" class="form-grid" hidden>
      <label>氏名<input name="canonical_name" value="${esc(person.canonical_name)}" required /></label>
      <label>表示名<input name="display_name" value="${esc(person.display_name ?? '')}" /></label>
      <label>タイプ<select name="person_type"><option value="">未設定</option>${typeOptions}</select></label>
      <label>ステータス<select name="status">${['active', 'inactive', 'unknown'].map((s) => `<option ${person.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="span-2">プロフィール<textarea name="short_bio" rows="3">${esc(person.profile?.short_bio ?? '')}</textarea></label>
      <button type="submit">保存</button>
    </form>
    <div>${aliases}
      <form id="aliasAddForm" class="inline-edit">
        <input name="alias" placeholder="別名を追加" required />
        <button type="submit" class="small">追加</button>
      </form>
    </div>
    <p>${esc(person.profile?.short_bio ?? '')}</p>
    <div class="columns">
      <div>
        <h3>SNS</h3><ul class="plain-list">${sns || '<li class="meta">未登録</li>'}</ul>
        <form id="snsAddForm" class="inline-edit">
          <select name="platform"><option value="">プラットフォーム...</option>${optionsHtml(SNS_PLATFORMS)}</select>
          <input name="handle" placeholder="handle" />
          <input name="follower_count" type="number" min="0" placeholder="フォロワー数" />
          <button type="submit" class="small">SNS追加</button>
        </form>
        <h3>関係（グループ・所属など）</h3>
        <ul class="plain-list">${relationshipList || '<li class="meta">なし</li>'}</ul>
        <form id="relationshipAddForm" class="inline-edit">
          <select name="related_person_id" required><option value="">相手の人物...</option>${personOptions}</select>
          <select name="relationship_type">${RELATIONSHIP_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
          <input name="role" placeholder="役割（例: 原作）" />
          <button type="submit" class="small">追加</button>
        </form>
        <p class="hint">複数人ユニットは「グループ側の人物（タイプ: group）」を作り、メンバー側から member_of で接続します。</p>
        <h3>カスタムフィールド</h3><dl class="kv">${fields || '<dt class="meta">なし</dt><dd></dd>'}</dl>
        ${
          fieldDefs.length
            ? `
        <form id="fieldValueForm" class="form-grid">
          <label>フィールド<select name="field_key">${fieldOptions}</select></label>
          <label>値<input name="value" placeholder="182 / 2026-01-01 / a,b,c" /></label>
          <button type="submit" class="small">値を設定</button>
        </form>`
            : '<p class="hint">スキーマタブでフィールドを定義すると、ここで値を設定できます。</p>'
        }
      </div>
      <div>
        <h3>直近コンテキスト</h3>${contexts || '<p class="meta">なし</p>'}
        <h3>サマリー</h3>${summaries || '<p class="meta">なし</p>'}
      </div>
    </div>`;

  const reload = () =>
    showPersonDetail(personId)
      .then(loadPersonList)
      .catch((error) => toast(error.message, true));
  const run = (promise, message) =>
    promise
      .then(() => {
        toast(message);
        return reload();
      })
      .catch((error) => toast(error.message, true));

  $('#personDetailClose').addEventListener('click', () => {
    panel.hidden = true;
  });

  panel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'person-edit-toggle') {
      const form = $('#personEditForm');
      form.hidden = !form.hidden;
    } else if (action === 'alias-delete') {
      if (confirm('この別名を削除しますか？（誤リンクの原因になっている別名の除去に使います）'))
        run(api(`/v1/persons/${personId}/aliases/${button.dataset.aliasId}`, { method: 'DELETE' }), '別名を削除しました');
    } else if (action === 'sns-edit-toggle') {
      const form = panel.querySelector(`[data-sns-form="${button.dataset.accountId}"]`);
      form.hidden = !form.hidden;
    } else if (action === 'sns-delete') {
      if (confirm('このSNSアカウントとメトリクス履歴を削除しますか？'))
        run(api(`/v1/persons/${personId}/sns/${button.dataset.accountId}`, { method: 'DELETE' }), 'SNSアカウントを削除しました');
    } else if (action === 'context-edit-toggle') {
      const form = panel.querySelector(`[data-context-form="${button.dataset.contextId}"]`);
      form.hidden = !form.hidden;
    } else if (action === 'context-reassign') {
      const select = panel.querySelector(`[data-reassign-select="${button.dataset.contextId}"]`);
      if (!select.value) return toast('付け替え先の人物を選んでください', true);
      if (confirm('このコンテキストを選択した人物へ付け替えますか？（この人物はこのソースの自動リンクから除外されます）'))
        run(
          api(`/v1/contexts/${button.dataset.contextId}`, { method: 'PATCH', body: JSON.stringify({ person_id: select.value }) }),
          'コンテキストを付け替えました'
        );
    } else if (action === 'context-delete') {
      if (!confirm('このコンテキストを削除しますか？')) return;
      const exclude = confirm('この人物へのリンク自体が誤りでしたか？\nOK: 再処理時もこのソースから除外する / キャンセル: 削除のみ');
      run(
        api(`/v1/contexts/${button.dataset.contextId}`, { method: 'DELETE', body: JSON.stringify({ exclude_person: exclude }) }),
        'コンテキストを削除しました'
      );
    } else if (action === 'relationship-delete') {
      if (confirm('この関係を削除しますか？'))
        run(api(`/v1/relationships/${button.dataset.relationshipId}`, { method: 'DELETE' }), '関係を削除しました');
    }
  });

  panel.addEventListener('submit', (event) => {
    const form = event.target;
    event.preventDefault();
    const data = new FormData(form);
    if (form.id === 'personEditForm') {
      const patch = {
        canonical_name: data.get('canonical_name'),
        display_name: data.get('display_name') || null,
        person_type: data.get('person_type') || null,
        status: data.get('status')
      };
      run(
        api(`/v1/persons/${personId}`, { method: 'PATCH', body: JSON.stringify(patch) }).then(() =>
          api(`/v1/persons/${personId}/profile`, { method: 'PATCH', body: JSON.stringify({ short_bio: data.get('short_bio') || null }) })
        ),
        '基本情報を更新しました'
      );
    } else if (form.id === 'aliasAddForm') {
      run(
        api(`/v1/persons/${personId}/aliases`, { method: 'POST', body: JSON.stringify({ alias: data.get('alias') }) }),
        '別名を追加しました'
      );
    } else if (form.id === 'relationshipAddForm') {
      if (!data.get('related_person_id')) return toast('相手の人物を選んでください', true);
      run(
        api(`/v1/persons/${personId}/relationships`, {
          method: 'POST',
          body: JSON.stringify({
            related_person_id: data.get('related_person_id'),
            relationship_type: data.get('relationship_type'),
            metadata: data.get('role') ? { role: data.get('role') } : undefined
          })
        }),
        '関係を追加しました'
      );
    } else if (form.id === 'snsAddForm') {
      if (!data.get('platform')) return toast('プラットフォームを選んでください', true);
      run(
        api(`/v1/persons/${personId}/sns`, {
          method: 'POST',
          body: JSON.stringify({
            platform: data.get('platform'),
            handle: data.get('handle') || undefined,
            follower_count: data.get('follower_count') ? Number(data.get('follower_count')) : undefined
          })
        }),
        'SNSアカウントを追加しました'
      );
    } else if (form.dataset.snsForm) {
      run(
        api(`/v1/persons/${personId}/sns/${form.dataset.snsForm}`, {
          method: 'PATCH',
          body: JSON.stringify({ handle: data.get('handle') || null, url: data.get('url') || null, status: data.get('status') })
        }),
        'SNSアカウントを更新しました'
      );
    } else if (form.dataset.contextForm) {
      run(
        api(`/v1/contexts/${form.dataset.contextForm}`, {
          method: 'PATCH',
          body: JSON.stringify({
            context_text: data.get('context_text'),
            context_tags: data
              .get('context_tags')
              ?.toString()
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
            role: data.get('role'),
            sentiment: data.get('sentiment')
          })
        }),
        'コンテキストを更新しました'
      );
    } else if (form.id === 'fieldValueForm') {
      const key = data.get('field_key');
      const def = fieldDefs.find((d) => d.key === key);
      let value = data.get('value')?.toString() ?? '';
      if (def && ['tag_list', 'enum_multi'].includes(def.type))
        value = value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
      if (def && def.type === 'boolean') value = value === 'true';
      if (def && def.type === 'number') value = Number(value);
      run(
        api(`/v1/persons/${personId}/fields`, { method: 'PATCH', body: JSON.stringify({ values: [{ field_key: key, value }] }) }),
        'フィールド値を更新しました'
      );
    }
  });
}

$('#personForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = {
    canonical_name: form.get('canonical_name'),
    display_name: form.get('display_name') || undefined,
    person_type: form.get('person_type') || undefined,
    aliases: form
      .get('aliases')
      ?.toString()
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean),
    profile: form.get('short_bio') ? { short_bio: form.get('short_bio') } : undefined,
    sns_accounts:
      form.get('sns_platform') && form.get('sns_handle')
        ? [
            {
              platform: form.get('sns_platform'),
              handle: form.get('sns_handle'),
              follower_count: form.get('sns_follower_count') ? Number(form.get('sns_follower_count')) : undefined
            }
          ]
        : undefined
  };
  try {
    await api('/v1/persons', { method: 'POST', body: JSON.stringify(body) });
    toast('人物を登録しました');
    event.target.reset();
    await loadPersonsTab();
  } catch (error) {
    toast(error.message, true);
  }
});

// ---------- sources ----------
async function fillTargetPersons() {
  const data = await api('/v1/persons?limit=100');
  $('#targetPersonSelect').innerHTML = data.results
    .map((person) => `<option value="${person.id}">${esc(person.display_name ?? person.canonical_name)}</option>`)
    .join('');
}

async function loadSourcesTab() {
  await Promise.all([loadSourceList(), fillTargetPersons()]);
}

async function loadSourceList() {
  const status = $('#sourceStatusFilter').value;
  const data = await api(`/v1/sources?limit=20${status ? `&processing_status=${status}` : ''}`);
  $('#sourceList').innerHTML = data.results.length
    ? data.results
        .map(
          (source) => `<div class="item clickable" data-source-id="${source.id}">
            <div class="item-head"><h3>${esc(source.title || '(タイトルなし)')}</h3>${statusBadge(source.processing_status)}</div>
            <p class="meta">${esc(source.source_type)} ・ ${esc(source.source_name ?? '')} ・ ${fmtDate(source.received_at)}</p>
            <p class="meta">${esc((source.body ?? '').slice(0, 120))}</p>
          </div>`
        )
        .join('')
    : '<p class="meta">ソースがまだありません。</p>';
}

$('#sourceStatusFilter').addEventListener('change', () => loadSourceList().catch((error) => toast(error.message, true)));

$('#sourceList').addEventListener('click', (event) => {
  const item = event.target.closest('[data-source-id]');
  if (item) showSourceDetail(item.dataset.sourceId).catch((error) => toast(error.message, true));
});

async function showSourceDetail(sourceId) {
  const [source, extractions] = await Promise.all([api(`/v1/sources/${sourceId}`), api(`/v1/sources/${sourceId}/extractions`)]);
  const panel = $('#sourceDetail');
  panel.hidden = false;
  const mentions = extractions.mentions.map((mention) => `<span class="badge muted">${esc(mention.mention)}</span>`).join('');
  const contexts = extractions.contexts
    .map(
      (context) => `<div class="evidence">${esc((context.context_text ?? '').slice(0, 200))}
        <span class="meta">person ${context.person_id.slice(0, 8)} / ${esc(context.role ?? '')} / ${esc(context.sentiment ?? '')}</span></div>`
    )
    .join('');
  const candidates = extractions.person_candidates
    .map((candidate) => `<li>${esc(candidate.mention)} ${statusBadge(candidate.status)}</li>`)
    .join('');
  const fieldCandidates = extractions.field_candidates
    .map(
      (candidate) =>
        `<li>${esc(candidate.field_definition_id.slice(0, 8))}... ${statusBadge(candidate.status)} <span class="meta">conf ${candidate.confidence ?? '-'}</span></li>`
    )
    .join('');
  panel.innerHTML = `
    <div class="item-head"><h2>${esc(source.title || '(タイトルなし)')}</h2>
      <div class="row-gap">
        <button class="ghost small" id="sourceReprocess">再処理</button>
        <button class="ghost small" id="sourceDetailClose">閉じる</button>
      </div>
    </div>
    <p class="meta">${esc(source.source_type)} / ${esc(source.source_subtype ?? '')} ・ ${statusBadge(source.processing_status)} ・ ${fmtDate(source.published_at)} ・ <span class="mono">${source.id}</span></p>
    <pre>${esc((source.body ?? '').slice(0, 1200))}</pre>
    <div class="columns">
      <div><h3>メンション</h3><div>${mentions || '<span class="meta">なし</span>'}</div>
        <h3>人物候補</h3><ul>${candidates || '<li class="meta">なし</li>'}</ul>
        <h3>フィールド候補</h3><ul>${fieldCandidates || '<li class="meta">なし</li>'}</ul></div>
      <div><h3>コンテキスト</h3>${contexts || '<p class="meta">なし</p>'}</div>
    </div>`;
  $('#sourceDetailClose').addEventListener('click', () => {
    panel.hidden = true;
  });
  $('#sourceReprocess').addEventListener('click', async () => {
    try {
      await api(`/v1/sources/${sourceId}/reprocess`, { method: 'POST' });
      toast('再処理ジョブを登録しました');
      setTimeout(() => showSourceDetail(sourceId).catch(() => {}), 1500);
    } catch (error) {
      toast(error.message, true);
    }
  });
}

$('#sourceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const targets = [...$('#targetPersonSelect').selectedOptions].map((option) => option.value);
  const publishedAt = form.get('published_at') ? new Date(form.get('published_at').toString()).toISOString() : undefined;
  const body = {
    source_type: form.get('source_type'),
    source_name: form.get('source_name') || undefined,
    title: form.get('title') || undefined,
    body: form.get('body') || undefined,
    url: form.get('url') || undefined,
    published_at: publishedAt,
    language: 'ja',
    target_person_ids: targets.length ? targets : undefined
  };
  try {
    const result = await api('/v1/sources', { method: 'POST', body: JSON.stringify(body) });
    toast(result.duplicate ? '同一ソースが既に存在します' : 'ソースを登録しました（処理キュー投入済み）');
    event.target.reset();
    setTimeout(() => loadSourceList().catch(() => {}), 800);
  } catch (error) {
    toast(error.message, true);
  }
});

// ---------- jobs ----------
async function loadJobs() {
  const status = $('#jobStatusFilter').value;
  const data = await api(`/v1/jobs?limit=30${status ? `&status=${status}` : ''}`);
  $('#jobList').innerHTML = data.results.length
    ? data.results
        .map((job) => {
          const steps = (job.metadata?.result?.steps ?? [])
            .map((step) => `${step.step}${step.detail ? ` (${step.detail})` : ''}`)
            .join(' → ');
          const actions = [
            ['failed', 'cancelled'].includes(job.status)
              ? `<button class="ghost small" data-action="retry" data-job-id="${job.id}">再実行</button>`
              : '',
            ['queued', 'retrying'].includes(job.status)
              ? `<button class="danger small" data-action="cancel" data-job-id="${job.id}">キャンセル</button>`
              : ''
          ].join(' ');
          return `<div class="item">
            <div class="item-head"><h3>${esc(job.job_type)}</h3><div class="row-gap">${statusBadge(job.status)}${actions}</div></div>
            <p class="meta">attempts ${job.attempts} ・ ${fmtDate(job.created_at)} ・ <span class="mono">${job.id}</span></p>
            ${steps ? `<p class="meta">${esc(steps)}</p>` : ''}
            ${job.error_message ? `<p class="meta">error: ${esc(job.error_message.slice(0, 200))}</p>` : ''}
          </div>`;
        })
        .join('')
    : '<p class="meta">ジョブがまだありません。</p>';
}

$('#jobStatusFilter').addEventListener('change', () => loadJobs().catch((error) => toast(error.message, true)));
$('#jobReload').addEventListener('click', () => loadJobs().catch((error) => toast(error.message, true)));
$('#jobList').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  try {
    await api(`/v1/jobs/${button.dataset.jobId}/${button.dataset.action}`, { method: 'POST' });
    toast(button.dataset.action === 'retry' ? '再実行しました' : 'キャンセルしました');
    await loadJobs();
  } catch (error) {
    toast(error.message, true);
  }
});

// ---------- schemas ----------
async function listFieldDefinitions() {
  const schemas = await api('/v1/schemas');
  const all = [];
  for (const schema of schemas.results) {
    const fields = await api(`/v1/schemas/${schema.id}/fields`);
    all.push(...fields.results);
  }
  return all;
}

async function loadSchemas() {
  const data = await api('/v1/schemas');
  $('#fieldSchemaSelect').innerHTML = data.results.map((schema) => `<option value="${schema.id}">${esc(schema.name)}</option>`).join('');
  const blocks = [];
  for (const schema of data.results) {
    const fields = await api(`/v1/schemas/${schema.id}/fields`);
    const rows = fields.results
      .map(
        (field) => `<li><strong>${esc(field.label)}</strong> <span class="mono">custom.${esc(field.key)}</span>
          <span class="badge muted">${esc(field.type)}</span>
          ${field.filterable ? '<span class="badge">filterable</span>' : ''}
          ${field.searchable ? '<span class="badge">searchable</span>' : ''}</li>`
      )
      .join('');
    blocks.push(`<div class="item">
      <div class="item-head"><h3>${esc(schema.name)}</h3><span class="mono">${esc(schema.key)}</span></div>
      <ul>${rows || '<li class="meta">フィールド未定義</li>'}</ul>
    </div>`);
  }
  $('#schemaList').innerHTML = blocks.join('') || '<p class="meta">スキーマがまだありません。</p>';
}

$('#schemaForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/v1/schemas', {
      method: 'POST',
      body: JSON.stringify({ key: form.get('key'), name: form.get('name'), description: form.get('description') || undefined })
    });
    toast('スキーマを作成しました');
    event.target.reset();
    await loadSchemas();
  } catch (error) {
    toast(error.message, true);
  }
});

$('#fieldForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const type = form.get('type');
  const enumValues =
    form
      .get('enum_values')
      ?.toString()
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean) ?? [];
  const extractionPrompt = form.get('extraction_prompt')?.toString().trim() ?? '';
  try {
    await api(`/v1/schemas/${form.get('schema_id')}/fields`, {
      method: 'POST',
      body: JSON.stringify({
        key: form.get('key'),
        label: form.get('label'),
        type,
        filterable: form.get('filterable') === 'on',
        searchable: form.get('searchable') === 'on',
        sortable: form.get('sortable') === 'on',
        embedding_target: form.get('embedding_target') === 'on',
        options: ['enum', 'enum_multi'].includes(type) ? { values: enumValues } : {},
        extraction_hints: extractionPrompt ? { prompt: extractionPrompt } : {}
      })
    });
    toast('フィールドを追加しました');
    event.target.reset();
    await loadSchemas();
  } catch (error) {
    toast(error.message, true);
  }
});

// ---------- candidates ----------
async function loadCandidates() {
  const [personCandidates, fieldCandidates, persons] = await Promise.all([
    api('/v1/person-candidates?limit=30'),
    api('/v1/extracted-field-candidates?limit=30'),
    api('/v1/persons?limit=100')
  ]);
  const personOptions = persons.results
    .map((person) => `<option value="${person.id}">${esc(person.display_name ?? person.canonical_name)}</option>`)
    .join('');
  $('#personCandidateList').innerHTML = personCandidates.results.length
    ? personCandidates.results
        .map((candidate) => {
          const open = candidate.status === 'pending';
          return `<div class="item">
          <div class="item-head"><h3>${esc(candidate.mention)}</h3>${statusBadge(candidate.status)}</div>
          <p class="meta">conf ${candidate.confidence ?? '-'} ・ ${fmtDate(candidate.created_at)} ・ 候補 ${candidate.candidate_person_ids?.length ?? 0} 件</p>
          ${
            open
              ? `<div class="row-gap">
            <select class="slim" data-link-select="${candidate.id}">${personOptions}</select>
            <button class="ghost small" data-candidate-action="link" data-candidate-id="${candidate.id}">この人物にリンク</button>
            <button class="ghost small" data-candidate-action="create-person" data-candidate-id="${candidate.id}">新規人物として作成</button>
            <button class="danger small" data-candidate-action="reject" data-candidate-id="${candidate.id}">却下</button>
          </div>`
              : ''
          }
        </div>`;
        })
        .join('')
    : '<p class="meta">レビュー待ちの人物候補はありません。</p>';

  $('#fieldCandidateList').innerHTML = fieldCandidates.results.length
    ? fieldCandidates.results
        .map((candidate) => {
          const open = ['pending', 'conflict'].includes(candidate.status);
          return `<div class="item">
          <div class="item-head"><h3>${esc(candidate.field_label ?? candidate.field_key ?? '')}</h3>${statusBadge(candidate.status)}</div>
          <p class="meta">value: <strong>${esc(JSON.stringify(candidate.value))}</strong> ・ conf ${candidate.confidence ?? '-'} ・ ${fmtDate(candidate.created_at)}</p>
          ${
            open
              ? `<div class="row-gap">
            <button class="ghost small" data-field-action="apply" data-candidate-id="${candidate.id}">適用</button>
            <button class="danger small" data-field-action="reject" data-candidate-id="${candidate.id}">却下</button>
          </div>`
              : ''
          }
        </div>`;
        })
        .join('')
    : '<p class="meta">レビュー待ちのフィールド候補はありません。</p>';
}

$('#personCandidateList').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-candidate-action]');
  if (!button) return;
  const id = button.dataset.candidateId;
  const action = button.dataset.candidateAction;
  try {
    if (action === 'link') {
      const select = document.querySelector(`[data-link-select="${id}"]`);
      await api(`/v1/person-candidates/${id}/link`, { method: 'POST', body: JSON.stringify({ person_id: select.value }) });
    } else {
      await api(`/v1/person-candidates/${id}/${action}`, { method: 'POST', body: '{}' });
    }
    toast('更新しました');
    await loadCandidates();
  } catch (error) {
    toast(error.message, true);
  }
});

$('#fieldCandidateList').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-field-action]');
  if (!button) return;
  try {
    await api(`/v1/extracted-field-candidates/${button.dataset.candidateId}/${button.dataset.fieldAction}`, { method: 'POST' });
    toast('更新しました');
    await loadCandidates();
  } catch (error) {
    toast(error.message, true);
  }
});

// ---------- system ----------
async function loadSystem() {
  const [capabilities, stats, fields] = await Promise.all([api('/v1/capabilities'), api('/v1/stats'), api('/v1/meta/searchable-fields')]);
  $('#capabilitiesView').textContent = JSON.stringify(capabilities, null, 2);
  $('#statsView').textContent = JSON.stringify(stats, null, 2);
  $('#searchableFieldsView').textContent = JSON.stringify(fields, null, 2);
}

// ---------- header / seed ----------
async function loadHeader() {
  const health = await api('/v1/health');
  const cap = health.capabilities;
  $('#capabilityBadge').textContent =
    `${health.store} ・ vector:on ・ full-text:${cap.full_text.enabled ? 'on' : 'off'} ・ llm:${cap.llm.provider}`;
  $('#capabilityBadge').className = `badge ${health.ok ? 'ok' : 'error'}`;
  $('#ftNote').textContent = cap.full_text.enabled ? ' + PGroonga全文検索' : '';
}

$('#seedButton').addEventListener('click', async () => {
  try {
    const persons = await api('/v1/persons?q=' + encodeURIComponent('燕谷千尋'));
    let person = persons.results[0];
    if (!person) {
      person = await api('/v1/persons', {
        method: 'POST',
        body: JSON.stringify({
          canonical_name: '燕谷千尋',
          person_type: 'actor',
          aliases: ['Tsubametani Chihiro', '燕谷さん'],
          profile: { short_bio: '俳優・モデル。清潔感のある広告出演が多く、環境保全活動にも関心がある。' },
          sns_accounts: [{ platform: 'instagram', handle: 'chihiro_tsubametani', follower_count: 1200000 }]
        })
      });
    }
    await api('/v1/sources', {
      method: 'POST',
      body: JSON.stringify({
        source_type: 'news',
        source_subtype: 'entertainment',
        source_name: 'PR TIMES',
        title: '燕谷千尋、環境保全プロジェクトのアンバサダーに就任',
        body: '燕谷千尋が海岸清掃ボランティアに参加し、環境保全プロジェクトのアンバサダーに就任。Instagram @chihiro_tsubametani でも活動を発信し、若年層への啓発を目指す。',
        url: 'https://example.com/news/tsubametani-ambassador',
        published_at: new Date().toISOString(),
        language: 'ja',
        target_person_ids: [person.id],
        idempotency_key: 'seed:tsubametani:environment'
      })
    });
    $('#searchForm input[name="query"]').value = 'Instagramフォロワー100万人以上で、環境保全の文脈で最近話題になっている人物';
    toast('サンプルデータを投入しました。数秒後に検索してください。');
  } catch (error) {
    toast(error.message, true);
  }
});

loadHeader().catch((error) => toast(error.message, true));
