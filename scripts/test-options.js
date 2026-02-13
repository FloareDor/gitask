const https = require('https');

function testOptions() {
	const options = {
		hostname: 'gitask2.vercel.app',
		port: 443,
		path: '/api/gemini',
		method: 'OPTIONS',
		headers: {
			'Origin': 'https://gitask2.vercel.app', // Simulate same-origin or cross-origin
			'Access-Control-Request-Method': 'POST',
			'Access-Control-Request-Headers': 'content-type'
		},
	};

	console.log(`Sending OPTIONS request to https://gitask2.vercel.app/api/gemini...`);

	const req = https.request(options, (res) => {
		console.log(`OPTIONS Response Status: ${res.statusCode}`);
		console.log('Relevant Headers:');
		console.log('Access-Control-Allow-Origin:', res.headers['access-control-allow-origin']);
		console.log('Access-Control-Allow-Methods:', res.headers['access-control-allow-methods']);
		console.log('Access-Control-Allow-Headers:', res.headers['access-control-allow-headers']);
		console.log('Allow:', res.headers['allow']);
	});

	req.on('error', (e) => {
		console.error(`Problem with OPTIONS request: ${e.message}`);
	});

	req.end();
}

testOptions();
