export default {
  fetch(request) {
    return new Response(`Localflare Worker: ${new URL(request.url).pathname}`);
  },
};
