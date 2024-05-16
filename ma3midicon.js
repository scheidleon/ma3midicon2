const easymidi = require('easymidi');
const osc = require('osc');
const { w3cwebsocket: W3CWebSocket } = require('websocket');
const client = new W3CWebSocket('ws://localhost:8080/');

const midi_in = 'MIDIcon 2';
const midi_out = 'MIDIcon 2';
const localip = '127.0.0.1';
const localport = 8020;
const remoteip = '127.0.0.1';
const remoteport = 8000;

const faderValue = Array.from({ length: 128 }, (_, i) => Math.min(100, i * 0.8));
const encoderState = Array.from({ length: 8 }, () => Array(8).fill(100));
const encposX = [204, 577, 946, 1315];

let grandmaster = 100, grandmasterfader = 127, BO = 0, keypressed = 0, matrixpage = 1, playbackpage = 1, maxPage = 5;

const udpPort = new osc.UDPPort({ localAddress: localip, localPort: localport, metadata: true });
udpPort.open();

console.log('MIDI inputs:', easymidi.getInputs());
console.log('MIDI outputs:', easymidi.getOutputs());

const input = new easymidi.Input(midi_in);
const output = new easymidi.Output(midi_out);

const sendPage = (controller, value) => output.send('cc', { controller, value, channel: 0 });
const sendCmd = (cmd) => udpPort.send({ address: '/cmd', args: [{ type: 's', value: cmd }] }, remoteip, remoteport);

sendPage(11, matrixpage);
sendPage(10, playbackpage);
sendCmd(`Page ${matrixpage}`);

input.on('cc', ({ controller, value }) => {
    if (controller <= 8) {
        udpPort.send({ address: `/Page${playbackpage}/Fader${controller + 200}`, args: [{ type: 'i', value: faderValue[value] }] }, remoteip, remoteport);
    } else if (controller === 9) {
        grandmaster = faderValue[value];
        grandmasterfader = value;
        if (!BO) {
            output.send('noteon', { note: 114, velocity: 127 - grandmasterfader, channel: 0 });
            sendCmd(`Master 2.1 At ${grandmaster}`);
        }
    }
});

const noteHandlers = {
    matrix: (msg) => {
        const key = (515 - ( Math.ceil(msg.note / 8) * 100 ) + ((msg.note % 8) || 8));
        udpPort.send({ address: `/Page${matrixpage}/Key${key}`, args: [{ type: 'i', value: keypressed }] }, remoteip, remoteport);
    },
    playback: (msg, offset, baseKey) => {
        const key = baseKey + (msg.note - offset);
        udpPort.send({ address: `/Page${playbackpage}/Key${key}`, args: [{ type: 'i', value: keypressed }] }, remoteip, remoteport);
    },
    playbackEncoder: (msg, baseKey) => {
        const index = Math.ceil((msg.note - 85) / 2) - 1;
        encoderState[playbackpage][index] += (msg.note % 2 === 0) ? 1 : - 1;
        encoderState[playbackpage][index] = Math.max(0, Math.min(100, encoderState[playbackpage][index]));
        udpPort.send({ address: `/Page${playbackpage}/Fader${index+baseKey}`, args: [{ type: 'i', value: encoderState[playbackpage][index] }] }, remoteip, remoteport);
    },
    pageUp: () => {
        matrixpage = Math.min(maxPage, matrixpage + 1);
        sendPage(11, matrixpage);
        sendCmd(`Page ${matrixpage}`);
    },
    pageDown: () => {
        matrixpage = Math.max(1, matrixpage - 1);
        sendPage(11, matrixpage);
        sendCmd(`Page ${matrixpage}`);
    },
    playPageUp: () => {
        playbackpage = Math.min(maxPage, playbackpage + 1);
        sendPage(10, playbackpage);
    },
    playPageDown: () => {
        playbackpage = Math.max(1, playbackpage - 1);
        sendPage(10, playbackpage)
    },
    encoder: (msg, encNum) => {
        const delta = msg.note % 2 === 0 ? 1 : -1;
        client.send('{"requestType":"nextFrame"}');
        client.send('{"requestType":"mouseEvent","posX":' + encposX[encNum-1] + ',"posY":995,"eventType":"wheel","deltaX":1,"deltaY":' + delta + ',"deltaZ":0,"deltaMode":0,"ctrlKey":false}');
    },
    blackOut: () => {
        BO = !BO;
        const cmd = `Master 2.1 At ${BO ? 0 : grandmaster}`;
        sendCmd(cmd);
        output.send('noteon', { note: 114, velocity: BO ? 127 : 127 - grandmasterfader, channel: 0 });
    }
};

input.on('noteon', (msg) => {
    keypressed = msg.velocity === 127 ? 1 : 0;
    const note = msg.note;

    if (note >= 1 && note <= 32) noteHandlers.matrix(msg);
    else if (note >= 33 && note <= 40) noteHandlers.playback(msg, 33, 191); //XKeys
    else if (note >= 41 && note <= 48) noteHandlers.playback(msg, 41, 201);
    else if (note >= 49 && note <= 56) noteHandlers.playback(msg, 49, 101);
    else if (note === 57 && keypressed) noteHandlers.playPageUp(5);
    else if (note === 58 && keypressed) noteHandlers.playPageDown(1);
    else if (note >= 59 && note <= 64) sendCmd(`Select EncoderBank ${note - 58}`);
    else if (note === 65 && keypressed) noteHandlers.pageUp();
    else if (note === 66 && keypressed) noteHandlers.pageDown();
    else if (note === 67) noteHandlers.blackOut();
    else if (note >= 68 && note <= 75) noteHandlers.playback(msg, 68, 301);
    else if (note >= 78 && note <= 85) noteHandlers.encoder(msg, Math.ceil((note - 77) / 2));
    else if (note >= 86 && note <= 101) noteHandlers.playbackEncoder(msg, 301);
});
console.log('Connecting to MA3PC ...');

client.onerror = () => console.log('Connection Error');
client.onopen = () => {
    console.log('WebSocket Client Connected');
    client.send(JSON.stringify({ requestType: 'remoteState' }));
};
client.onclose = () => {
    console.log('MA3 Connection Closed');
    input.close();
    process.exit();
};
client.onmessage = function (e) {

    if (typeof e.data == 'string') {
        obj = JSON.parse(e.data);

        if (obj.status == "server ready") {
            console.log("SERVER READY");
            client.send('{"requestType":"remoteState"}')
        }

        if (obj.type == "remoteState") {
            console.log("Remote State");
            client.send('{"requestType":"resizeVideo","width":2048,"height":1056}');
            client.send('{"requestType":"requestVideo"}');
        }

        if (obj.MA == "00") {
            console.log(obj);
            client.send('{"requestType":"nextFrame"}');
        }
    }
}