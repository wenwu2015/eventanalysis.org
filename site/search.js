(() => {
  const query = document.querySelector("[data-search-query]");
  const facets = [...document.querySelectorAll("[data-search-facet]")];
  const results = [...document.querySelectorAll("[data-search-result]")];
  const empty = document.querySelector("[data-search-empty]");
  if (!query || !results.length) return;
  const apply = () => {
    const term = query.value.normalize("NFKC").toLocaleLowerCase().trim();
    let visible = 0;
    for (const result of results) {
      const match = (!term || result.dataset.text.includes(term)) && facets.every((facet) => {
        if (!facet.value) return true;
        const candidate = result.dataset[facet.dataset.searchFacet] || "";
        return facet.dataset.searchFacet === "entities" ? candidate.split(" ").includes(facet.value) : candidate === facet.value;
      });
      result.hidden = !match;
      if (match) visible += 1;
    }
    empty.hidden = visible !== 0;
  };
  const params = new URLSearchParams(location.search);
  query.value = params.get("q") || "";
  for (const facet of facets) facet.value = params.get(facet.dataset.searchFacet) || "";
  query.addEventListener("input", apply);
  for (const facet of facets) facet.addEventListener("change", apply);
  apply();
})();
