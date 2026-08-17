(function (root) {
  "use strict";

  const STATE_KEYS = [
    "rosters",
    "roomAssignments",
    "titleAssignments",
    "selectedRosterId",
    "highlightPresent",
    "missingCollapsed",
    "missingHeight",
    "detailedEditor",
    "mattermostUrl",
    "showMattermostStatuses",
    "lastMattermostTeamId",
    "lastMattermostChannelId",
    "expectedParticipants",
    "rosterText"
  ];

  function newId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `roster-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // Источник состава: null — список ведётся руками, иначе канал Mattermost.
  function cleanSource(source) {
    if (!source || source.type !== "mattermost") return null;
    const baseUrl = VRMattermost.normalizeBaseUrl(source.baseUrl);
    const channelId = String(source.channelId || "").trim();
    const channelName = String(source.channelName || "").trim();
    if (!baseUrl || (!channelId && !channelName)) return null;
    return {
      type: "mattermost",
      baseUrl,
      teamId: String(source.teamId || "").trim(),
      teamName: String(source.teamName || "").trim(),
      channelId,
      channelName,
      channelDisplayName: String(source.channelDisplayName || channelName).trim(),
      syncedAt: Number(source.syncedAt) || 0
    };
  }

  // Привязки встреч: и по адресу комнаты, и по её названию. Записи на
  // удалённые списки отбрасываются.
  function onlyValid(assignments, validIds) {
    return Object.fromEntries(
      Object.entries(assignments || {}).filter(([key, rosterId]) => key && validIds.has(rosterId))
    );
  }

  function cleanRoster(roster) {
    if (!roster || !roster.id) return null;
    const participants = VRMeetups.parseExpected(
      Array.isArray(roster.participants) ? roster.participants.join("\n") : roster.participants
    );
    const participantKeys = new Set(participants.map(VRMeetups.comparisonKey));
    const statuses = {};
    Object.entries(roster.statuses || {}).forEach(([nameKey, status]) => {
      const normalizedKey = VRMeetups.comparisonKey(nameKey);
      const normalizedStatus = VRMeetups.normalizeStatus(status);
      if (participantKeys.has(normalizedKey) && normalizedStatus) {
        statuses[normalizedKey] = normalizedStatus;
      }
    });
    const aliases = {};
    const claimedAliasKeys = new Set(participantKeys);
    Object.entries(roster.aliases || {}).forEach(([nameKey, values]) => {
      const expectedKey = VRMeetups.comparisonKey(nameKey);
      if (!participantKeys.has(expectedKey)) return;

      const uniqueAliases = [];
      (Array.isArray(values) ? values : [values]).forEach((alias) => {
        const displayName = String(alias || "").replace(/\s+/g, " ").trim();
        const aliasKey = VRMeetups.comparisonKey(displayName);
        if (!aliasKey || claimedAliasKeys.has(aliasKey)) return;
        claimedAliasKeys.add(aliasKey);
        uniqueAliases.push(displayName);
      });
      if (uniqueAliases.length) aliases[expectedKey] = uniqueAliases;
    });
    return {
      id: String(roster.id),
      name: String(roster.name || "Без названия").trim() || "Без названия",
      participants,
      statuses,
      aliases,
      source: cleanSource(roster.source),
      createdAt: roster.createdAt || Date.now(),
      updatedAt: roster.updatedAt || Date.now()
    };
  }

  async function load() {
    const stored = await chrome.storage.local.get(STATE_KEYS);
    let rosters = Array.isArray(stored.rosters)
      ? stored.rosters.map(cleanRoster).filter(Boolean)
      : [];
    let migrated = false;

    if (!rosters.length) {
      const legacyParticipants = VRMeetups.parseExpected(
        Array.isArray(stored.expectedParticipants)
          ? stored.expectedParticipants.join("\n")
          : stored.rosterText
      );

      if (legacyParticipants.length) {
        rosters = [{
          id: newId(),
          name: "Основной список",
          participants: legacyParticipants,
          statuses: {},
          aliases: {},
          createdAt: Date.now(),
          updatedAt: Date.now()
        }];
        migrated = true;
      }
    }

    const validIds = new Set(rosters.map((roster) => roster.id));
    const roomAssignments = onlyValid(stored.roomAssignments, validIds);
    const titleAssignments = onlyValid(stored.titleAssignments, validIds);
    const selectedRosterId = validIds.has(stored.selectedRosterId)
      ? stored.selectedRosterId
      : (rosters[0]?.id || null);

    const state = {
      rosters,
      roomAssignments,
      titleAssignments,
      selectedRosterId,
      highlightPresent: stored.highlightPresent !== false,
      missingCollapsed: stored.missingCollapsed === true,
      missingHeight: VRMeetups.clampMissingHeight(stored.missingHeight),
      detailedEditor: stored.detailedEditor === true,
      mattermostUrl: VRMattermost.normalizeBaseUrl(stored.mattermostUrl),
      showMattermostStatuses: stored.showMattermostStatuses !== false,
      lastMattermostTeamId: String(stored.lastMattermostTeamId || ""),
      lastMattermostChannelId: String(stored.lastMattermostChannelId || "")
    };
    const sanitized = Array.isArray(stored.rosters) && JSON.stringify(stored.rosters) !== JSON.stringify(rosters);
    if (migrated || sanitized) await save(state);
    return state;
  }

  async function save(state) {
    const rosters = (state.rosters || []).map(cleanRoster).filter(Boolean);
    const selected = VRMeetups.rosterById(rosters, state.selectedRosterId) || rosters[0] || null;
    const validIds = new Set(rosters.map((roster) => roster.id));
    const roomAssignments = onlyValid(state.roomAssignments, validIds);
    const titleAssignments = onlyValid(state.titleAssignments, validIds);

    const cleanState = {
      rosters,
      roomAssignments,
      titleAssignments,
      selectedRosterId: selected?.id || null,
      highlightPresent: state.highlightPresent !== false,
      missingCollapsed: state.missingCollapsed === true,
      missingHeight: VRMeetups.clampMissingHeight(state.missingHeight),
      detailedEditor: state.detailedEditor === true,
      mattermostUrl: VRMattermost.normalizeBaseUrl(state.mattermostUrl),
      showMattermostStatuses: state.showMattermostStatuses !== false,
      lastMattermostTeamId: String(state.lastMattermostTeamId || ""),
      lastMattermostChannelId: String(state.lastMattermostChannelId || ""),
      // These two fields keep version 1.0 data compatible during an update.
      expectedParticipants: selected?.participants || [],
      rosterText: (selected?.participants || []).join("\n")
    };
    await chrome.storage.local.set(cleanState);
    return cleanState;
  }

  // Кеш последней отрисовки хранится отдельно от настроек: он меняется часто,
  // а слушатели изменений следят только за ключами состояния.
  const RESULTS_KEY = "lastResults";
  const RESULTS_LIMIT = 8;

  async function loadResults() {
    const stored = await chrome.storage.local.get(RESULTS_KEY);
    const results = stored[RESULTS_KEY];
    return results && typeof results === "object" ? VRMeetups.pruneCache(results, RESULTS_LIMIT) : {};
  }

  async function saveResult(key, entry) {
    if (!key) return {};
    const results = await loadResults();
    results[key] = entry;
    const pruned = VRMeetups.pruneCache(results, RESULTS_LIMIT);
    await chrome.storage.local.set({ [RESULTS_KEY]: pruned });
    return pruned;
  }

  // Команды и каналы Mattermost: кеш нужен, чтобы выпадающие списки не
  // открывались пустыми, пока идёт запрос.
  const LISTS_KEY = "mmLists";

  async function loadLists() {
    const stored = await chrome.storage.local.get(LISTS_KEY);
    return VRMattermost.normalizeLists(stored[LISTS_KEY]);
  }

  async function saveLists(lists) {
    const normalized = VRMattermost.normalizeLists({ ...lists, fetchedAt: Date.now() });
    await chrome.storage.local.set({ [LISTS_KEY]: normalized });
    return normalized;
  }

  root.VRMStorage = { load, save, newId, loadResults, saveResult, loadLists, saveLists };
})(typeof globalThis !== "undefined" ? globalThis : window);
