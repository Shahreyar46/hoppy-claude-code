# Hoppy voice recorder: records the default Windows microphone to a 16 kHz mono WAV file.
# Uses winmm.dll (built into Windows), so nothing is installed. Hoppy starts it hidden,
# writes any line to stdin to stop, and reads REC / SAVED / ERR lines from stdout.
param([Parameter(Mandatory = $true)][string]$Out)

Add-Type -Namespace HoppyVoice -Name Mci -MemberDefinition '[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int len, System.IntPtr cb);'

function Send([string]$cmd) {
    $code = [HoppyVoice.Mci]::mciSendString($cmd, $null, 0, [IntPtr]::Zero)
    if ($code -ne 0) {
        [Console]::Out.WriteLine("ERR $code")
        [Console]::Out.Flush()
    }
    return $code
}

# Closes a recording left open by a crashed run; fails quietly when there is none.
[void][HoppyVoice.Mci]::mciSendString('close hoppyrec', $null, 0, [IntPtr]::Zero)
if ((Send 'open new type waveaudio alias hoppyrec') -ne 0) { exit 2 }
[void](Send 'set hoppyrec bitspersample 16 samplespersec 16000 channels 1 bytespersec 32000 alignment 2')
if ((Send 'record hoppyrec') -ne 0) {
    [void](Send 'close hoppyrec')
    exit 2
}
[Console]::Out.WriteLine('REC')
[Console]::Out.Flush()

[void][Console]::In.ReadLine()

[void](Send 'stop hoppyrec')
$saved = Send ('save hoppyrec "' + $Out + '"')
[void](Send 'close hoppyrec')
if ($saved -ne 0) { exit 3 }
[Console]::Out.WriteLine('SAVED')
[Console]::Out.Flush()
