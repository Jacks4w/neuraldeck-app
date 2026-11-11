const {contextBridge, ipcRenderer} = require("electron");

async function call(channel, ...args) {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
}

function on(channel, cb) {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("deck", {
    state: () => call("app:state"),
    detectHardware: () => call("hw:detect"),
    download: (tier) => call("setup:download", tier),
    cancelDownload: () => call("setup:cancel"),
    reloadEngine: () => call("engine:reload"),
    setSettings: (patch) => call("settings:set", patch),
    listConversations: () => call("conv:list"),
    getConversation: (id) => call("conv:get", id),
    createConversation: () => call("conv:create"),
    deleteConversation: (id) => call("conv:delete", id),
    renameConversation: (id, title) => call("conv:rename", id, title),
    send: (convId, text) => call("chat:send", {convId, text}),
    stop: (convId) => call("chat:stop", convId),
    update: () => call("kb:update"),
    loadDemo: () => call("kb:loadDemo"),
    cancelUpdate: () => call("kb:cancel"),
    kbInfo: () => call("kb:info"),
    rebuild: () => call("kb:rebuild"),
    openDataDir: () => call("app:openDataDir"),
    openExternal: (url) => call("app:openExternal", url),
    refocus: () => ipcRenderer.send("win:refocus"),
    on
});
