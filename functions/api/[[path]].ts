interface Env {
  ERDFORGE: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  return context.env.ERDFORGE.fetch(context.request);
};