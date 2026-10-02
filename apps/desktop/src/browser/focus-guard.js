// Agent input reaches a page over CDP and needs no OS focus, but Chromium still moves native
// focus into a page whose element takes focus. Only the person may put focus in a page.
module.exports = {
  async keepCockpitFocus(scope, work) {
    if (this.window.isDestroyed() || !this.window.webContents.isFocused?.()) return work();
    this.focusHolds.set(scope, (this.focusHolds.get(scope) || 0) + 1);
    try {
      return await work();
    } finally {
      const left = this.focusHolds.get(scope) - 1;
      if (left) this.focusHolds.set(scope, left);
      else this.focusHolds.delete(scope);
      for (const tab of this.scopeTabs(scope)) this.returnFocusFrom(tab);
    }
  },

  noteTabFocused(tab) {
    if (this.focusHolds.has(tab.scopeKey) || !this.isTabShown(tab)) this.returnFocusFrom(tab);
  },

  returnFocusFrom(tab) {
    const page = tab.view?.webContents;
    if (!page || page.isDestroyed() || !page.isFocused?.()) return;
    if (this.previewing(tab) || this.humanActive(tab) || this.window.isDestroyed()) return;
    this.window.webContents.focus();
  },
};
