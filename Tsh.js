const net = require('net');
const dgram = require('dgram');

const TCP_PORT = 1080;
const UDP_PORT = 1081;

const OP = {
    PITCH: 0x10,
    YAW: 0x14,
    RECOIL: 0x18,
    GRAVITY: 0x1C,
    SPREAD: 0x20,
    AIM: 0x24
};

const server = net.createServer((socket) => {
    let state = 'handshake';
    let buf = Buffer.alloc(0);
    let udp = null;

    socket.on('data', (data) => {
        buf = Buffer.concat([buf, data]);

        if (state === 'handshake') {
            if (buf.length >= 3 && buf[0] === 0x05) {
                socket.write(Buffer.from([0x05, 0x00]));
                state = 'request';
                buf = buf.slice(3);
            }
            return;
        }

        if (state === 'request') {
            if (buf.length < 4) return;
            const cmd = buf[1];
            const atyp = buf[3];
            let addrLen;
            if (atyp === 0x01) addrLen = 4;
            else if (atyp === 0x03) addrLen = buf[4] + 1;
            else if (atyp === 0x04) addrLen = 16;
            else { socket.destroy(); return; }
            const total = 4 + addrLen + 2;
            if (buf.length < total) return;

            if (cmd === 0x03) {
                udp = dgram.createSocket('udp4');
                udp.bind(UDP_PORT, '127.0.0.1', () => {
                    const reply = Buffer.from([
                        0x05, 0x00, 0x00, 0x01,
                        0x7F, 0x00, 0x00, 0x01,
                        (UDP_PORT >> 8) & 0xFF, UDP_PORT & 0xFF
                    ]);
                    socket.write(reply);
                    state = 'udp';
                    buf = Buffer.alloc(0);

                    udp.on('message', (msg, rinfo) => {
                        if (msg.length < 4) return;
                        const atyp = msg[3];
                        let addrLen;
                        if (atyp === 0x01) addrLen = 4;
                        else if (atyp === 0x03) addrLen = msg[4] + 1;
                        else if (atyp === 0x04) addrLen = 16;
                        else return;
                        const headerLen = 4 + addrLen + 2;
                        if (msg.length < headerLen) return;

                        const data = msg.slice(headerLen);
                        const modified = modifyPacket(data);
                        if (modified) {
                            const newMsg = Buffer.concat([msg.slice(0, headerLen), modified]);
                            let dstAddr, dstPort;
                            if (atyp === 0x01) {
                                dstAddr = msg.slice(4, 8);
                                dstPort = msg.readUInt16BE(8);
                                const ip = dstAddr.join('.');
                                const out = dgram.createSocket('udp4');
                                out.send(newMsg, 0, newMsg.length, dstPort, ip, () => out.close());
                            } else if (atyp === 0x03) {
                                const domainLen = msg[4];
                                const domain = msg.slice(5, 5 + domainLen).toString();
                                dstPort = msg.readUInt16BE(5 + domainLen);
                                const out = dgram.createSocket('udp4');
                                out.send(newMsg, 0, newMsg.length, dstPort, domain, () => out.close());
                            }
                        } else {
                            let dstAddr, dstPort;
                            if (atyp === 0x01) {
                                dstAddr = msg.slice(4, 8);
                                dstPort = msg.readUInt16BE(8);
                                const ip = dstAddr.join('.');
                                const out = dgram.createSocket('udp4');
                                out.send(msg, 0, msg.length, dstPort, ip, () => out.close());
                            } else if (atyp === 0x03) {
                                const domainLen = msg[4];
                                const domain = msg.slice(5, 5 + domainLen).toString();
                                dstPort = msg.readUInt16BE(5 + domainLen);
                                const out = dgram.createSocket('udp4');
                                out.send(msg, 0, msg.length, dstPort, domain, () => out.close());
                            }
                        }
                    });
                });
            } else {
                socket.destroy();
            }
        }
    });

    socket.on('close', () => { if (udp) udp.close(); });
});

server.listen(TCP_PORT, '127.0.0.1', () => {
    console.log('SOCKS5 proxy running on port ' + TCP_PORT);
});

function modifyPacket(data) {
    if (data.length < 0x30) return null;
    if (data[0] !== 0xFF || data[1] !== 0xAA) return null;

    const mod = Buffer.from(data);

    mod.writeFloatLE(0.0, OP.PITCH);
    mod.writeFloatLE(0.0, OP.YAW);

    const recoil = mod.readFloatLE(OP.RECOIL);
    mod.writeFloatLE(recoil * 0.2, OP.RECOIL);

    const gravity = mod.readFloatLE(OP.GRAVITY);
    mod.writeFloatLE(gravity * 0.2, OP.GRAVITY);

    const spread = mod.readFloatLE(OP.SPREAD);
    mod.writeFloatLE(spread * 0.1, OP.SPREAD);

    mod.writeUInt8(0xFF, OP.AIM);

    mod[mod.length - 1] = (mod[mod.length - 1] + 1) % 0x100;

    return mod;
}