import test from 'node:test';
import assert from 'node:assert/strict';
import {rootCertificates} from 'node:tls';
import {sameCertificate} from './runtime-certificates.cjs';
test('native HTTPS fixtures pin the exact certificate across Windows and Unix PEM encodings',()=>{
 const pem=rootCertificates[0].replace(/\r\n/g,'\n');
 const windows=pem.replace(/\n/g,'\r\n');
 assert.notEqual(pem.trim(),windows.trim());
 assert.equal(sameCertificate(pem,windows),true);
 assert.equal(sameCertificate(windows,pem),true);
 assert.equal(sameCertificate(pem,rootCertificates[1]),false);
 assert.equal(sameCertificate('invalid',pem),false);
});
