const http = require('http');

function testRequest(method, data) {
	const options = {
		hostname: 'localhost',
		port: 3000,
		path: '/api/gemini',
		method: method,
		headers: {
			'Content-Type': 'application/json',
		},
	};

	const req = http.request(options, (res) => {
		let body = '';
		res.on('data', (chunk) => {
			body += chunk;
		});
		res.on('end', () => {
			console.log(`${method} Response Status: ${res.statusCode}`);
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
testRequest('GET');

setTimeout(() => {
	console.log('\nTesting POST request...');
	testRequest('POST', {
		messages: [{ role: 'user', content: 'Hello' }]
	});
}, 1000);
