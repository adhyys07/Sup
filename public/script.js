const socket = io();
const room = 'sup-room'

let localStream;
let peerConnection;

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

navigator.mediaDevices.getUserMedia({ video: true, audio: true })
.then(stream => {
    localStream = stream;
    localVideo.srcObject = stream;
    socket.emit('join-room', room);
});

socket.on("user-joined", async (id) => {
    peerConnection = createPeerConnection(id);
    
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    socket.emit("signal",{
        to:id,
        signal: offer
    });
});
socket.on("signal", async (data) => {
    if (!peerConnection){
        peerConnection = createPeerConnection(data.from);
    }
    if(data.signal.type === 'offer'){
        await peerConnection.setRemoteDescription(data.signal);
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        socket.emit("signal",{
            to: data.from,
            signal: answer
        });
    }   

    if(data.signal.type === 'answer'){
        await peerConnection.setRemoteDescription(data.signal);
    }
});

function createPeerConnection(id){
    const pc = new RTCPeerConnection();

    localStream.getTracks().forEach(track =>{
        pc.addTrack(track, localStream)
    });  
    pc.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0];
    };
    return pc;
}