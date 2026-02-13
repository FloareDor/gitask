const https = require('https');

function testProdRequest(method, data) {
	const options = {
		hostname: 'gitask2.vercel.app',
		port: 443,
		path: '/api/gemini',
		method: method,
		headers: {
			'Content-Type': 'application/json',
		},
	};

	console.log(`Sending ${method} request to https://gitask2.vercel.app/api/gemini...`);

	const req = https.request(options, (res) => {
		let body = '';
		res.on('data', (chunk) => {
			body += chunk;
		});
		res.on('end', () => {
			console.log(`${method} Response Status: ${res.statusCode}`);
			console.log(`${method} Response Headers:`, res.headers);
			console.log(`${method} Response Body: ${body}`);
		});
	});

	req.on('error', (e) => {
		console.error(`Problem with ${method} request: ${e.message}`);
	});

	if (data) {
		req.write(JSON.stringify(data));
	}
	req.end();
}

console.log('Testing GET request...');
testProdRequest('GET');

setTimeout(() => {
	console.log('\nTesting POST request...');
	testProdRequest('POST', {
		messages: [{ role: 'user', content: 'Hello' }]
	});
}, 2000);

setTimeout(() => {
	console.log('\nTesting OPTIONS request...');
	testProdRequest('OPTIONS');
}, 5000);
