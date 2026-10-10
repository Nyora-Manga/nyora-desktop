// Visibility follows acknowledged native preferences, including after restart.
export function mountCommunityLinks(services, store, toast) {
  const button = document.getElementById('desktop-dismiss-community');
  const update = () => {
    document.documentElement.dataset.communityLinks = services.uiPreferences().hideCommunityLinks === true ? 'hidden' : 'shown';
  };
  update();
  services.subscribe(update);
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    const focused = document.activeElement === button;
    try {
      await store.set({ hideCommunityLinks: true });
      if (focused && [button, document.body].includes(document.activeElement)) {
        const target = ['#searchInput', '#navToggle', '#sidebar [data-route="settings"]']
          .map(selector => document.querySelector(selector)).find(element => element?.getClientRects().length);
        target?.focus();
      }
    } catch {
      toast('Could not save this choice. Please try again.');
    } finally { button.disabled = false; }
  });
}
