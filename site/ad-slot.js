(function () {
  "use strict";

  var configNode = document.getElementById("ea-ad-config");
  if (!configNode) return;

  var config;
  try {
    config = JSON.parse(configNode.textContent || "{}");
  } catch (_error) {
    return;
  }
  if (!config.enabled || !config.placements) return;

  document.querySelectorAll("[data-ea-ad]").forEach(function (slot) {
    var placement = slot.getAttribute("data-placement");
    var creative = config.placements[placement];
    var storageKey = "ea-ad-dismissed:" + placement;
    if (!creative || sessionStorage.getItem(storageKey) === "1") {
      slot.remove();
      return;
    }

    var aside = document.createElement("aside");
    aside.className = "ad-slot page-width";
    aside.setAttribute("aria-label", "Advertisement");

    var label = document.createElement("span");
    label.className = "ad-label";
    label.textContent = "AD";
    label.title = "Advertisement";
    label.tabIndex = 0;

    var close = document.createElement("button");
    close.type = "button";
    close.className = "ad-close";
    close.textContent = "×";
    close.title = "Close advertisement";
    close.setAttribute("aria-label", "Close advertisement");
    close.addEventListener("click", function () {
      sessionStorage.setItem(storageKey, "1");
      aside.remove();
    });

    var link = document.createElement("a");
    link.className = "ad-link";
    link.href = creative.href;
    link.target = "_blank";
    link.rel = "nofollow noopener noreferrer";

    var copy = document.createElement("span");
    var headline = document.createElement("strong");
    headline.textContent = creative.headline;
    copy.appendChild(headline);
    copy.appendChild(document.createElement("br"));
    copy.appendChild(document.createTextNode(creative.body));
    link.appendChild(copy);

    aside.append(label, close, link);
    slot.replaceWith(aside);
  });
})();
