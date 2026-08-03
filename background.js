// Groups every tab opened from a link with its opener (parent) tab.
// Works even if the parent isn't in a group yet: in that case a new
// group is created containing both the parent and the child, so any
// further tabs opened from either one join the same group.

// Tracks openerTabId -> Promise while a "create a new group" operation
// is in flight, so two children opened in quick succession from the
// same ungrouped parent land in the same new group instead of each
// spawning their own.
const pendingGroupCreation = new Map();
const tabGroupByTabId = new Map();
const singletonCheckTimers = new Map();

function rememberTabGroup(tab) {
  if (!tab || tab.id == null) return;
  tabGroupByTabId.set(
    tab.id,
    tab.groupId ?? chrome.tabGroups.TAB_GROUP_ID_NONE,
  );
}

async function seedTabGroupCache() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      rememberTabGroup(tab);
    }
  } catch (error) {
    console.debug('group-child-tabs: failed to seed tab cache', error);
  }
}

function scheduleSingletonUngroupCheck(groupId) {
  if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;

  const existingTimer = singletonCheckTimers.get(groupId);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(async () => {
    singletonCheckTimers.delete(groupId);
    try {
      const tabsInGroup = await chrome.tabs.query({ groupId });
      if (tabsInGroup.length !== 1) return;
      await chrome.tabs.ungroup(tabsInGroup[0].id);
    } catch (error) {
      // Group may no longer exist by the time this runs.
      console.debug('group-child-tabs: singleton ungroup skipped', error);
    }
  }, 0);

  singletonCheckTimers.set(groupId, timer);
}

seedTabGroupCache();

function isBlankOrNewTabUrl(url) {
  return (
    url === 'about:blank' ||
    url === 'about:newtab' ||
    url === 'chrome://newtab/'
  );
}

chrome.tabs.onCreated.addListener(async tab => {
  rememberTabGroup(tab);

  const openerTabId = tab.openerTabId;
  if (openerTabId == null) return; // not opened from a link/window.open

  const initialUrl = tab.pendingUrl || tab.url || '';
  if (isBlankOrNewTabUrl(initialUrl)) return;

  try {
    const opener = await chrome.tabs.get(openerTabId);

    // Pinned tabs should never start a child tab group.
    if (opener.pinned) return;

    // Don't try to group across windows (e.g. "open link in new window").
    if (opener.windowId !== tab.windowId) return;

    if (opener.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      // Parent already belongs to a group — just join it.
      await chrome.tabs.group({ tabIds: [tab.id], groupId: opener.groupId });
      return;
    }

    // Parent isn't grouped yet. If another child from the same parent
    // is already creating a group right now, wait for it and join.
    if (pendingGroupCreation.has(openerTabId)) {
      const groupId = await pendingGroupCreation.get(openerTabId);
      await chrome.tabs.group({ tabIds: [tab.id], groupId });
      return;
    }

    let resolveCreation;
    let rejectCreation;
    const creation = new Promise((resolve, reject) => {
      resolveCreation = resolve;
      rejectCreation = reject;
    });
    pendingGroupCreation.set(openerTabId, creation);
    try {
      const groupId = await chrome.tabs.group({ tabIds: [opener.id, tab.id] });
      resolveCreation(groupId);
      await creation;
    } catch (error) {
      rejectCreation(error);
      throw error;
    } finally {
      pendingGroupCreation.delete(openerTabId);
    }
  } catch (err) {
    // Opener may have already closed, or the tab was opened in a way
    // that can't be grouped (e.g. a discarded/prerendered tab). Ignore.
    console.debug('group-child-tabs: skipped', err);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!Object.prototype.hasOwnProperty.call(changeInfo, 'groupId')) return;

  const previousGroupId = tabGroupByTabId.get(tabId);
  const nextGroupId = changeInfo.groupId;
  tabGroupByTabId.set(tabId, nextGroupId);

  if (
    previousGroupId != null &&
    previousGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE &&
    previousGroupId !== nextGroupId
  ) {
    scheduleSingletonUngroupCheck(previousGroupId);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  const previousGroupId = tabGroupByTabId.get(tabId);
  tabGroupByTabId.delete(tabId);

  if (
    previousGroupId != null &&
    previousGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
  ) {
    scheduleSingletonUngroupCheck(previousGroupId);
  }
});
