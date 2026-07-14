export async function onRequest(context) {
  return context.env.API.fetch(context.request)
}

