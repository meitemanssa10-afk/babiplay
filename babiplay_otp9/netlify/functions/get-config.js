exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      surl: process.env.SUPABASE_URL,
      skey: process.env.SUPABASE_ANON_KEY
    })
  };
};
