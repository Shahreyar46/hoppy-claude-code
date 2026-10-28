// Launches an isolated VS Code (own user-data and extensions dir) with Hoppy loaded and runs test/suite.
const path = require('path');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const root = path.resolve(__dirname, '..');
    const tmp = path.join(os.tmpdir(), 'modelhop-test');
    try {
        await runTests({
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
            launchArgs: [
                process.env.MODELHOP_TEST_WORKSPACE || root,
                '--user-data-dir', path.join(tmp, 'user-data'),
                '--extensions-dir', path.join(os.tmpdir(), 'modelhop-test-ext'),
                '--disable-workspace-trust',
            ],
        });
    } catch (err) {
        console.error('Tests failed', err);
        process.exit(1);
    }
}

main();
