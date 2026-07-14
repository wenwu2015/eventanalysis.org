// Sites requires a Worker entrypoint in the deployment archive. This contains no
// rendering logic: it delegates requests to the immutable static-asset binding.
export default {
  async fetch(request, environment) {
    if (environment?.ASSETS?.fetch) return environment.ASSETS.fetch(request);
    return new Response("Static asset unavailable", { status: 404 });
  },
};
