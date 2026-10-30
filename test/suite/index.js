const path = require('path');
const Mocha = require('mocha');

exports.run = function () {
    const mocha = new Mocha({ ui: 'tdd', timeout: 60000, color: false });
    mocha.addFile(path.join(__dirname, 'extension.test.js'));
    if (process.env.HOPPY_QA) {
        mocha.addFile(path.join(__dirname, 'qa.test.js'));
    }
    return new Promise((resolve, reject) => {
        mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
    });
};
