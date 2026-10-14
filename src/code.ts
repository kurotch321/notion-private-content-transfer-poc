const NOTION_VERSION = '2022-06-28';
const DESTINATION_PREFIX = 'destination:';
const MAX_PARENT_TRACE_DEPTH = 20;
const EXECUTE_CONFIRM_PHRASE = 'MOVE';

type JsonObject = { [key: string]: unknown };

interface DestinationRecord {
  userKey: string;
  destinationPageId: string;
  updatedAt: string;
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface ValidatePatInput {
  userKey: string;
  pat: string;
}

interface CandidateInput {
  pat: string;
  query?: string;
  pageSize?: number;
  startCursor?: string;
}

interface TransferInput {
  userKey: string;
  pat: string;
  selectedPageIds: string[];
  confirmPhrase?: string;
}

interface PageCandidate {
  pageId: string;
  title: string;
  path: string;
  parentType: string;
  isTopLevelPrivate: boolean;
}

interface DryRunItem {
  sourcePageId: string;
  sourceTitle: string;
  topLevelPageId: string;
  topLevelTitle: string;
  willMove: boolean;
  reason?: string;
}

function doGet(e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.HTML.HtmlOutput {
  const page = e.parameter.page === 'admin' ? 'admin' : 'employee';
  return HtmlService.createTemplateFromFile(page)
    .evaluate()
    .setTitle(page === 'admin' ? 'Notion移管PoC 管理者画面' : 'Notion移管PoC 退職予定者ウィザード')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename: string): string {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function saveDestinationRecord(userKey: string, destinationPageId: string): ApiResult<DestinationRecord> {
  const normalizedUserKey = userKey.trim().toLowerCase();
  const normalizedPageId = normalizeNotionId(destinationPageId);
  if (!normalizedUserKey) {
    return { ok: false, error: '対象ユーザー識別子を入力してください。' };
  }
  if (!normalizedPageId) {
    return { ok: false, error: '移管先ページIDを入力してください。' };
  }

  const record: DestinationRecord = {
    userKey: normalizedUserKey,
    destinationPageId: normalizedPageId,
    updatedAt: new Date().toISOString()
  };
  PropertiesService.getScriptProperties().setProperty(destinationPropertyKey(normalizedUserKey), JSON.stringify(record));
  return { ok: true, data: record };
}

function getDestinationRecord(userKey: string): ApiResult<DestinationRecord> {
  const normalizedUserKey = userKey.trim().toLowerCase();
  if (!normalizedUserKey) {
    return { ok: false, error: '対象ユーザー識別子を入力してください。' };
  }
  const raw = PropertiesService.getScriptProperties().getProperty(destinationPropertyKey(normalizedUserKey));
  if (!raw) {
    return { ok: false, error: '移管先ページIDが未登録です。管理者へ連絡してください。' };
  }
  const record = JSON.parse(raw) as DestinationRecord;
  return { ok: true, data: record };
}

function validatePatForDestination(input: ValidatePatInput): ApiResult<JsonObject> {
  const destinationResult = getDestinationRecord(input.userKey);
  if (!destinationResult.ok || !destinationResult.data) {
    return { ok: false, error: destinationResult.error };
  }
  const destinationPageId = destinationResult.data.destinationPageId;

  const pageResult = notionRetrievePage(destinationPageId, input.pat);
  if (!pageResult.ok || !pageResult.data) {
    return {
      ok: false,
      error: `PAT検証に失敗しました。移管先ページへアクセスできません。${pageResult.error ? ` (${pageResult.error})` : ''}`
    };
  }

  return {
    ok: true,
    data: {
      destinationPageId,
      destinationTitle: extractPageTitle(pageResult.data)
    }
  };
}

function listPrivatePageCandidates(input: CandidateInput): ApiResult<JsonObject> {
  const pageSize = Math.min(Math.max(input.pageSize || 20, 1), 50);
  const searchPayload: JsonObject = {
    filter: { property: 'object', value: 'page' },
    page_size: pageSize
  };
  if (input.query && input.query.trim()) {
    searchPayload.query = input.query.trim();
  }
  if (input.startCursor) {
    searchPayload.start_cursor = input.startCursor;
  }

  const searchResult = notionRequest('/v1/search', 'post', input.pat, searchPayload);
  if (!searchResult.ok || !searchResult.data) {
    return { ok: false, error: searchResult.error || 'ページ検索に失敗しました。' };
  }

  const response = searchResult.data;
  const results = (response.results as JsonObject[]) || [];
  const cache: { [pageId: string]: JsonObject } = {};
  const candidates = results.map((page) => toPageCandidate(page, input.pat, cache));

  return {
    ok: true,
    data: {
      candidates,
      hasMore: Boolean(response.has_more),
      nextCursor: response.next_cursor || null
    }
  };
}

function dryRunTransfer(input: TransferInput): ApiResult<JsonObject> {
  return runTransfer(input, false);
}

function executeTransfer(input: TransferInput): ApiResult<JsonObject> {
  if ((input.confirmPhrase || '').trim().toUpperCase() !== EXECUTE_CONFIRM_PHRASE) {
    return { ok: false, error: `最終確認のため ${EXECUTE_CONFIRM_PHRASE} と入力してください。` };
  }
  return runTransfer(input, true);
}

function runTransfer(input: TransferInput, execute: boolean): ApiResult<JsonObject> {
  const destinationResult = getDestinationRecord(input.userKey);
  if (!destinationResult.ok || !destinationResult.data) {
    return { ok: false, error: destinationResult.error };
  }
  const destinationPageId = destinationResult.data.destinationPageId;
  if (!Array.isArray(input.selectedPageIds) || input.selectedPageIds.length === 0) {
    return { ok: false, error: '移管対象ページを1つ以上選択してください。' };
  }

  const destinationCheck = notionRetrievePage(destinationPageId, input.pat);
  if (!destinationCheck.ok) {
    return { ok: false, error: `移管先ページにアクセスできません。${destinationCheck.error ? ` (${destinationCheck.error})` : ''}` };
  }

  const pageCache: { [pageId: string]: JsonObject } = {};
  const dryRunItems: DryRunItem[] = [];
  const moveTargets: { [pageId: string]: DryRunItem } = {};

  input.selectedPageIds.forEach((rawPageId) => {
    const pageId = normalizeNotionId(rawPageId);
    const pageResult = notionRetrievePage(pageId, input.pat);
    if (!pageResult.ok || !pageResult.data) {
      dryRunItems.push({
        sourcePageId: pageId,
        sourceTitle: '取得失敗',
        topLevelPageId: pageId,
        topLevelTitle: '取得失敗',
        willMove: false,
        reason: pageResult.error || '対象ページを取得できませんでした。'
      });
      return;
    }

    pageCache[pageId] = pageResult.data;
    const topLevelResult = resolveTopLevelPrivatePage(pageResult.data, input.pat, pageCache);
    if (!topLevelResult.ok || !topLevelResult.data) {
      dryRunItems.push({
        sourcePageId: pageId,
        sourceTitle: extractPageTitle(pageResult.data),
        topLevelPageId: pageId,
        topLevelTitle: extractPageTitle(pageResult.data),
        willMove: false,
        reason: topLevelResult.error || 'Private直下ページを特定できませんでした。'
      });
      return;
    }

    const topPage = topLevelResult.data;
    const topPageId = String(topPage.id || pageId);
    const topPageTitle = extractPageTitle(topPage);
    const duplicate = moveTargets[topPageId];
    if (duplicate) {
      dryRunItems.push({
        sourcePageId: pageId,
        sourceTitle: extractPageTitle(pageResult.data),
        topLevelPageId: topPageId,
        topLevelTitle: topPageTitle,
        willMove: false,
        reason: '同一トップレベル配下のため重複としてスキップ予定。'
      });
      return;
    }

    const item: DryRunItem = {
      sourcePageId: pageId,
      sourceTitle: extractPageTitle(pageResult.data),
      topLevelPageId: topPageId,
      topLevelTitle: topPageTitle,
      willMove: true
    };
    dryRunItems.push(item);
    moveTargets[topPageId] = item;
  });

  const targetIds = Object.keys(moveTargets);
  if (!execute) {
    return {
      ok: true,
      data: {
        destinationPageId,
        confirmPhrase: EXECUTE_CONFIRM_PHRASE,
        items: dryRunItems,
        summary: summarizeDryRun(dryRunItems)
      }
    };
  }

  const results = targetIds.map((topLevelPageId) => movePageToDestination(topLevelPageId, destinationPageId, input.pat, moveTargets[topLevelPageId]));
  const skipped = dryRunItems.filter((item) => !item.willMove).map((item) => ({
    pageId: item.sourcePageId,
    title: item.sourceTitle,
    status: 'skipped',
    reason: item.reason || '条件により移動対象外'
  }));

  return {
    ok: true,
    data: {
      destinationPageId,
      results: results.concat(skipped),
      summary: summarizeExecute(results, skipped)
    }
  };
}

function movePageToDestination(pageId: string, destinationPageId: string, pat: string, source: DryRunItem): JsonObject {
  const payload = {
    parent: {
      type: 'page_id',
      page_id: destinationPageId
    }
  };

  const patchResult = notionRequest(`/v1/pages/${pageId}`, 'patch', pat, payload);
  if (!patchResult.ok || !patchResult.data) {
    return {
      pageId,
      sourcePageId: source.sourcePageId,
      title: source.topLevelTitle,
      status: 'failed',
      reason: patchResult.error || 'Move APIに失敗しました。'
    };
  }

  const moved = patchResult.data;
  return {
    pageId,
    sourcePageId: source.sourcePageId,
    title: source.topLevelTitle,
    status: 'success',
    newParentType: ((moved.parent as JsonObject)?.type as string) || 'unknown',
    newParentPageId: ((moved.parent as JsonObject)?.page_id as string) || null
  };
}

function resolveTopLevelPrivatePage(
  page: JsonObject,
  pat: string,
  cache: { [pageId: string]: JsonObject }
): ApiResult<JsonObject> {
  let current = page;
  for (let i = 0; i < MAX_PARENT_TRACE_DEPTH; i += 1) {
    const parent = (current.parent || {}) as JsonObject;
    const parentType = String(parent.type || '');

    if (parentType === 'workspace') {
      return { ok: true, data: current };
    }
    if (parentType !== 'page_id') {
      return { ok: false, error: `未対応の親タイプです: ${parentType || 'unknown'}` };
    }

    const parentPageId = normalizeNotionId(String(parent.page_id || ''));
    if (!parentPageId) {
      return { ok: false, error: '親ページIDを解決できませんでした。' };
    }

    if (cache[parentPageId]) {
      current = cache[parentPageId];
      continue;
    }

    const parentResult = notionRetrievePage(parentPageId, pat);
    if (!parentResult.ok || !parentResult.data) {
      return { ok: false, error: `親ページを取得できませんでした: ${parentResult.error || 'unknown error'}` };
    }
    cache[parentPageId] = parentResult.data;
    current = parentResult.data;
  }

  return { ok: false, error: '親ページ探索の上限を超えました。' };
}

function toPageCandidate(page: JsonObject, pat: string, cache: { [pageId: string]: JsonObject }): PageCandidate {
  const pageId = normalizeNotionId(String(page.id || ''));
  cache[pageId] = page;
  const parent = (page.parent || {}) as JsonObject;
  const parentType = String(parent.type || 'unknown');

  let topLevelPrivate = false;
  const topLevel = resolveTopLevelPrivatePage(page, pat, cache);
  if (topLevel.ok && topLevel.data) {
    topLevelPrivate = normalizeNotionId(String(topLevel.data.id || '')) === pageId;
  }

  return {
    pageId,
    title: extractPageTitle(page),
    path: buildPagePath(page, pat, cache),
    parentType,
    isTopLevelPrivate: topLevelPrivate
  };
}

function buildPagePath(page: JsonObject, pat: string, cache: { [pageId: string]: JsonObject }): string {
  const names: string[] = [];
  let current: JsonObject | null = page;
  for (let i = 0; i < MAX_PARENT_TRACE_DEPTH && current; i += 1) {
    names.push(extractPageTitle(current));
    const parent = (current.parent || {}) as JsonObject;
    const parentType = String(parent.type || '');
    if (parentType === 'workspace') {
      names.push('Private Root');
      break;
    }
    if (parentType !== 'page_id') {
      break;
    }
    const parentPageId = normalizeNotionId(String(parent.page_id || ''));
    if (!parentPageId) {
      break;
    }
    if (!cache[parentPageId]) {
      const result = notionRetrievePage(parentPageId, pat);
      if (!result.ok || !result.data) {
        break;
      }
      cache[parentPageId] = result.data;
    }
    current = cache[parentPageId];
  }
  return names.reverse().join(' / ');
}

function notionRetrievePage(pageId: string, pat: string): ApiResult<JsonObject> {
  if (!pageId) {
    return { ok: false, error: 'ページIDが空です。' };
  }
  return notionRequest(`/v1/pages/${normalizeNotionId(pageId)}`, 'get', pat);
}

function notionRequest(
  path: string,
  method: GoogleAppsScript.URL_Fetch.HttpMethod,
  pat: string,
  payload?: JsonObject
): ApiResult<JsonObject> {
  if (!pat || !pat.trim()) {
    return { ok: false, error: 'PATを入力してください。' };
  }

  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + pat.trim(),
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    }
  };
  if (payload) {
    options.payload = JSON.stringify(payload);
  }

  let response: GoogleAppsScript.URL_Fetch.HTTPResponse;
  try {
    response = UrlFetchApp.fetch(`https://api.notion.com${path}`, options);
  } catch (error) {
    return { ok: false, error: `Notion API呼び出し失敗: ${toErrorMessage(error)}` };
  }

  const status = response.getResponseCode();
  const text = response.getContentText();
  const body = parseJson(text);

  if (status >= 200 && status < 300) {
    return { ok: true, data: body };
  }

  const notionCode = String((body.code as string) || '');
  const notionMessage = String((body.message as string) || text || 'unknown error');
  if (status === 429) {
    const headers = response.getHeaders() as { [key: string]: string };
    const retryAfter = headers['Retry-After'];
    return {
      ok: false,
      error: `Notion APIがレート制限を返しました(429)。Retry-After=${retryAfter || 'unknown'}。`
    };
  }
  if (status === 403 || status === 404) {
    return {
      ok: false,
      error: `権限またはリソースエラー (${status}/${notionCode}): ${notionMessage}`
    };
  }
  return { ok: false, error: `Notion APIエラー (${status}/${notionCode}): ${notionMessage}` };
}

function summarizeDryRun(items: DryRunItem[]): JsonObject {
  const move = items.filter((item) => item.willMove).length;
  const skip = items.length - move;
  return { move, skip, total: items.length };
}

function summarizeExecute(successes: JsonObject[], skipped: JsonObject[]): JsonObject {
  const success = successes.filter((item) => item.status === 'success').length;
  const failed = successes.filter((item) => item.status === 'failed').length;
  const skip = skipped.length;
  return {
    success,
    failed,
    skip,
    total: success + failed + skip
  };
}

function parseJson(content: string): JsonObject {
  try {
    return JSON.parse(content) as JsonObject;
  } catch (_error) {
    return {};
  }
}

function extractPageTitle(page: JsonObject): string {
  const properties = (page.properties || {}) as { [key: string]: JsonObject };
  const key = Object.keys(properties).find((name) => String((properties[name].type as string) || '') === 'title');
  if (!key) {
    return String((page.id as string) || 'Untitled');
  }
  const title = (properties[key].title as JsonObject[]) || [];
  const plainText = title.map((item) => String(item.plain_text || '')).join('').trim();
  return plainText || 'Untitled';
}

function normalizeNotionId(value: string): string {
  return (value || '').trim().replace(/-/g, '').toLowerCase();
}

function destinationPropertyKey(userKey: string): string {
  return `${DESTINATION_PREFIX}${userKey}`;
}

function toErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
