exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);

    const response = await fetch('https://app.paydunya.com/api/v1/checkout-invoice/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYDUNYA-MASTER-KEY': 'jcyYoPdO-9Va3-z1zT-dA9h-o7k45e1RtPhw',
        'PAYDUNYA-PUBLIC-KEY': 'live_public_oUZuGErxeGMmHnNsdRQ6wEZCvaQ',
        'PAYDUNYA-PRIVATE-KEY': 'live_private_D2z4U3WUILZRv2UozJ1j2938WQg',
        'PAYDUNYA-TOKEN': 'p7BKpdsI15SXHDGUT7Sr'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
