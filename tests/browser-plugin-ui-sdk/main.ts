import { createPluginUiClient, type PluginUiViewSnapshot } from "@vykor/plugins/ui-sdk";
if (window.parent !== window) {
  void createPluginUiClient().then(client => {
    client.onSnapshot((snapshot: PluginUiViewSnapshot) => {
      document.querySelector("#status")!.textContent = String(snapshot.data.count ?? "");
    });
  });
}
