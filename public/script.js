// ==================================================
// オンラインルーレット：メインスクリプト
// --------------------------------------------------
// このスクリプトは、ルーレットの描画、ユーザー操作、WebSocket 通信等の処理を行います。
// ==================================================

// ----- ヘッダークリックでトップページへ遷移 -----
document.querySelector("header").addEventListener("click", () => {
  window.location.href = "roulette.html";
});

// ----- URLパラメータからルーム名を自動入力 ----- 
window.addEventListener('load', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) {
    // 余分な空白を削除して設定
    document.getElementById('roomInput').value = roomParam.trim();
  }
});

// ----- HTMLサニタイズ関数（基本的なエスケープ処理） -----
function sanitize(str) {
  return str.replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
}

// ----- グローバル状態変数 ----- 
let currentRoom = "";
let roomStates = {};
let rollResults = [];
let currentSpinId = null;
let sections = [], colors = [], arc = 0;
let startAngle = 0, spinAngleStart = 0, spinTime = 0, spinTimeTotal = 0;
let isSpinning = false;

// ----- WebSocket 接続関連 ----- 
let ws;
const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const reconnectDelay = 5000;      // 再接続までの遅延（ミリ秒）
const heartbeatInterval = 30000;  // ハートビート送信間隔（ミリ秒）
let heartbeatTimer = null;

// ハートビート開始
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, heartbeatInterval);
}

// ハートビート停止
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// WebSocket 接続および再接続処理
function connectWebSocket() {
  ws = new WebSocket(wsProtocol + "//" + location.host);
  
  ws.onopen = () => {
    console.log("WebSocket connected");
    // ユーザー名（前後の空白を削除・サニタイズ）をサーバへ送信
    let username = document.getElementById('usernameInput').value.trim();
    username = sanitize(username).substring(0, 100);
    ws.send(JSON.stringify({ type: "setUsername", username }));
    // 既にルームが設定されている場合は参加メッセージを送信
    if (currentRoom !== "") {
      ws.send(JSON.stringify({ type: "joinRoom", room: currentRoom, username }));
    } else {
      document.getElementById('joinRoomBtn').disabled = false;
    }
    startHeartbeat();
  };
  
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "pong") return;
    console.log("Received:", msg);
    switch (msg.type) {
      case "roomInfo":
        // 参加者情報の更新
        document.getElementById('infoParticipants').textContent =
          "参加者: " + msg.clients.map(c => c.username).join(", ");
        break;
      case "roomJoined":
        // ルーム入室成功時の画面切替
        document.getElementById('roomContainer').style.display = "none";
        document.body.classList.add("joined");
        fadeIn(document.getElementById('infoPanel'));
        fadeIn(document.getElementById('rouletteArea'));
        fadeIn(document.getElementById('configArea'));
        document.getElementById('infoRoomName').textContent = "ルーム: " + msg.room;
        currentRoom = msg.room;
        // 共有URL の生成と各SNS連携設定
        const shareURL = location.origin + location.pathname + "?room=" + encodeURIComponent(msg.room);
        document.getElementById('shareArea').innerHTML = generateShareHTML(shareURL);
        registerShareEvents(shareURL);
        // ルーム退出ボタンの設定
        document.getElementById('leaveRoomBtn').addEventListener('click', () => {
          if (currentRoom !== "") {
            roomStates[currentRoom] = {
              sections: sections.slice(),
              rollResults: rollResults.slice(),
              result: document.getElementById('result').textContent
            };
            ws.send(JSON.stringify({ type: "userLeft", room: currentRoom }));
          }
          currentRoom = "";
          document.body.classList.remove("joined");
          document.getElementById('roomContainer').style.display = "block";
        });
        break;
      case "resetResult":
        // 必要に応じてリセット処理を実装
        break;
      case "spin":
        // ルーレット回転開始時の処理
        document.getElementById("result").textContent = "";
        console.log("Spin started by:", msg.spunBy);
        startAngle = 0;
        spinAngleStart = msg.spinData.spinAngleStart;
        spinTime = 0;
        spinTimeTotal = msg.spinData.spinTimeTotal;
        const delay = msg.spinData.scheduledStartTime - Date.now();
        setTimeout(() => { if (!isSpinning) { isSpinning = true; rotateWheel(); } }, Math.max(0, delay));
        break;
      case "updateParameters":
        // ルーレット設定の更新
        applyParameters(msg.parameters);
        rollResults = [];
        updateResultHistory();
        break;
      case "updateResults":
        // ルーレット結果の更新
        rollResults = msg.results;
        if (!isSpinning) updateResultHistory();
        break;
    }
  };
  
  ws.onclose = () => {
    console.log("WebSocket disconnected.");
    stopHeartbeat();
    setTimeout(() => { connectWebSocket(); }, reconnectDelay);
  };
  
  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    ws.close();
  };
}

connectWebSocket();

// ページ離脱時にルーム退出メッセージを送信
window.addEventListener("beforeunload", () => {
  if (currentRoom !== "") {
    ws.send(JSON.stringify({ type: "userLeft", room: currentRoom }));
  }
});

// ----- ユーザー名変更イベント ----- 
document.getElementById("usernameInput").addEventListener("change", () => {
  let username = document.getElementById("usernameInput").value.trim();
  username = sanitize(username).substring(0, 100);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "setUsername", username }));
  }
});

// ----- 共有URL生成とSNS連携用関数 ----- 
function generateShareHTML(shareURL) {
  return "共有URL: <a href='" + shareURL + "' target='_blank'>" + shareURL + "</a>" +
         " <button id='copyBtn' class='snsBtn'>コピー</button>" +
         " <button id='twitterBtn' class='snsBtn'>X</button>" +
         " <button id='facebookBtn' class='snsBtn'>Facebook</button>" +
         " <button id='lineBtn' class='snsBtn'>LINE</button>" +
         " <button id='teamsBtn' class='snsBtn'>Teams</button>" +
         " <button id='genericShareBtn' class='snsBtn'>共有</button>";
}
function registerShareEvents(shareURL) {
  document.getElementById("copyBtn").addEventListener("click", () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(shareURL)
        .then(() => { showCopyMessage(); })
        .catch(err => { fallbackCopyTextToClipboard(shareURL); });
    } else {
      fallbackCopyTextToClipboard(shareURL);
    }
  });
  document.getElementById("twitterBtn").addEventListener("click", () => {
    const text = encodeURIComponent("ルーレットに参加しよう！");
    const xURL = "https://twitter.com/intent/tweet?url=" + encodeURIComponent(shareURL) + "&text=" + text;
    window.open(xURL, "_blank");
  });
  document.getElementById("facebookBtn").addEventListener("click", () => {
    const facebookURL = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(shareURL);
    window.open(facebookURL, "_blank");
  });
  document.getElementById("lineBtn").addEventListener("click", () => {
    const lineText = encodeURIComponent("ルーレットに参加しよう！ " + shareURL);
    const lineURL = "https://social-plugins.line.me/lineit/share?url=" + encodeURIComponent(shareURL) + "&text=" + lineText;
    window.open(lineURL, "_blank");
  });
  document.getElementById("teamsBtn").addEventListener("click", () => {
    const teamsURL = "https://teams.microsoft.com/l/share?url=" + encodeURIComponent(shareURL);
    window.open(teamsURL, "_blank");
  });
  document.getElementById("genericShareBtn").addEventListener("click", () => {
    if (navigator.share) {
      navigator.share({
        title: "ルーレットに参加しよう！",
        text: "ルーレットに参加しよう！",
        url: shareURL
      }).catch(err => console.error(err));
    } else {
      alert("このブラウザはシェア機能に対応していません。URLをコピーしてください。");
    }
  });
}

// ----- ルーム入室処理 ----- 
document.getElementById("joinRoomBtn").addEventListener("click", () => {
  let roomName = document.getElementById("roomInput").value.trim();
  let username = document.getElementById("usernameInput").value.trim();
  // サニタイズと最大文字数制限（ユーザー名 100文字、ルーム名 200文字）
  username = sanitize(username).substring(0, 100);
  roomName = sanitize(roomName).substring(0, 200);
  if (username === "") {
    alert("ユーザー名を入力してください。");
    return;
  }
  if (roomName === "") {
    alert("ルーム名を入力してください。");
    return;
  }
  // 以前保存されたルーム状態があれば復元
  if (roomStates[roomName]) {
    const savedState = roomStates[roomName];
    sections = savedState.sections;
    rollResults = savedState.rollResults;
    applyParameters(sections);
    updateResultHistory();
    document.getElementById("result").textContent = savedState.result;
  } else {
    rollResults = [];
    sections = ["A", "B"];
    applyParameters(sections);
    updateResultHistory();
    document.getElementById("result").textContent = "";
  }
  ws.send(JSON.stringify({ type: "setUsername", username }));
  ws.send(JSON.stringify({ type: "joinRoom", room: roomName, username }));
});

// ----- ルーレット項目設定（入力欄および同期処理） ----- 
document.querySelectorAll(".itemInput").forEach(input => {
  input.addEventListener("blur", () => {
    input.value = input.value.trim();
  });
  attachInputSync(input);
});

const baseColors = ["#FF8A80","#FF80AB","#B388FF","#8C9EFF","#80D8FF","#A7FFEB","#CCFF90","#FFFF8D"];

function attachInputSync(input) {
  input.addEventListener("input", () => {
    if (updateSections()) {
      sendUpdateParameters();
      drawRouletteWheel();
    }
  });
}

function updateSections() {
  const inputs = document.querySelectorAll(".itemInput");
  sections = [];
  inputs.forEach(input => {
    let val = input.value;
    let displayVal = sanitize(val).trim().substring(0, 300);
    if (displayVal !== "") { sections.push(displayVal); }
  });
  if (sections.length < 2) return false;
  colors = sections.map((_, i) => baseColors[i % baseColors.length]);
  arc = (2 * Math.PI) / sections.length;
  return true;
}
updateSections();

function sendUpdateParameters() {
  ws.send(JSON.stringify({ type: "updateParameters", parameters: sections }));
}

function applyParameters(parameters) {
  const container = document.getElementById("itemsContainer");
  container.innerHTML = "";
  parameters.forEach(item => {
    const itemDiv = document.createElement("div");
    itemDiv.className = "item fade-in";
    const dragHandle = document.createElement("div");
    dragHandle.className = "dragHandle";
    dragHandle.textContent = "≡";
    dragHandle.setAttribute("draggable", "true");
    dragHandle.addEventListener("dragstart", handleDragStart);
    dragHandle.addEventListener("dragend", handleDragEnd);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "itemInput";
    input.setAttribute("maxlength", "300");
    input.value = item;
    attachInputSync(input);
    const removeBtn = document.createElement("button");
    removeBtn.className = "removeItemBtn";
    removeBtn.textContent = "×";
    attachRemoveHandler(removeBtn);
    itemDiv.appendChild(dragHandle);
    itemDiv.appendChild(input);
    itemDiv.appendChild(removeBtn);
    itemDiv.addEventListener("dragover", handleItemDragOver);
    itemDiv.addEventListener("dragleave", handleItemDragLeave);
    itemDiv.addEventListener("drop", handleItemDrop);
    container.appendChild(itemDiv);
  });
  updateSections();
  drawRouletteWheel();
}

function attachRemoveHandler(button) {
  button.addEventListener("click", () => {
    const container = document.getElementById("itemsContainer");
    if (container.childElementCount > 2) {
      button.parentElement.remove();
      if (updateSections()) {
        sendUpdateParameters();
        drawRouletteWheel();
      }
    } else {
      alert("少なくとも2つの項目は必要です。");
    }
  });
}
document.querySelectorAll(".removeItemBtn").forEach(attachRemoveHandler);
document.querySelectorAll(".itemInput").forEach(attachInputSync);

// ----- ドラッグ＆ドロップによる項目並び替え ----- 
let dragSrcItem = null;
function handleDragStart(e) {
  dragSrcItem = this.parentNode;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", "");
  dragSrcItem.classList.add("dragging");
}
function handleDragEnd(e) {
  document.querySelectorAll("#itemsContainer .item").forEach(item => item.classList.remove("over"));
  if (dragSrcItem) { dragSrcItem.classList.remove("dragging"); }
}
function handleItemDragOver(e) {
  if (e.preventDefault) e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  this.classList.add("over");
  return false;
}
function handleItemDragLeave(e) { this.classList.remove("over"); }
function handleItemDrop(e) {
  if (e.stopPropagation) e.stopPropagation();
  if (dragSrcItem && dragSrcItem !== this) {
    const container = document.getElementById("itemsContainer");
    container.insertBefore(dragSrcItem, this);
    updateSections();
    sendUpdateParameters();
    drawRouletteWheel();
  }
  this.classList.remove("over");
  return false;
}
document.querySelectorAll("#itemsContainer .dragHandle").forEach(handle => {
  handle.addEventListener("dragstart", handleDragStart);
  handle.addEventListener("dragend", handleDragEnd);
});
document.querySelectorAll("#itemsContainer .item").forEach(item => {
  item.addEventListener("dragover", handleItemDragOver);
  item.addEventListener("dragleave", handleItemDragLeave);
  item.addEventListener("drop", handleItemDrop);
});

// ----- 項目追加およびリセットボタンの処理 ----- 
const addItemBtn = document.getElementById("addItemBtn");
addItemBtn.addEventListener("click", () => {
  const container = document.getElementById("itemsContainer");
  const itemDiv = document.createElement("div");
  itemDiv.className = "item fade-in";
  const dragHandle = document.createElement("div");
  dragHandle.className = "dragHandle";
  dragHandle.textContent = "≡";
  dragHandle.setAttribute("draggable", "true");
  dragHandle.addEventListener("dragstart", handleDragStart);
  dragHandle.addEventListener("dragend", handleDragEnd);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "itemInput";
  input.setAttribute("maxlength", "300");
  input.value = "";
  attachInputSync(input);
  const removeBtn = document.createElement("button");
  removeBtn.className = "removeItemBtn";
  removeBtn.textContent = "×";
  attachRemoveHandler(removeBtn);
  itemDiv.appendChild(dragHandle);
  itemDiv.appendChild(input);
  itemDiv.appendChild(removeBtn);
  itemDiv.addEventListener("dragover", handleItemDragOver);
  itemDiv.addEventListener("dragleave", handleItemDragLeave);
  itemDiv.addEventListener("drop", handleItemDrop);
  container.appendChild(itemDiv);
  if (updateSections()) { sendUpdateParameters(); }
});

const resetBtn = document.getElementById("resetBtn");
resetBtn.addEventListener("click", () => {
  sections = ["A", "B"];
  sendUpdateParameters();
  applyParameters(sections);
  rollResults = [];
  updateResultHistory();
  document.getElementById("result").textContent = "";
  ws.send(JSON.stringify({ type: "resetResult" }));
  document.getElementById("result").textContent = "結果リセット済み";
  setTimeout(() => { document.getElementById("result").textContent = ""; }, 2000);
});

// ----- ルーレット描画と回転処理 ----- 
const canvas = document.getElementById("wheel");
const ctx = canvas.getContext("2d");

// ルーレットの描画
function drawRouletteWheel() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (sections.length < 2) return;
  const outsideRadius = 230, insideRadius = 50, textRadius = 180;
  for (let i = 0; i < sections.length; i++) {
    const angle = startAngle + i * arc;
    ctx.fillStyle = colors[i];
    ctx.beginPath();
    ctx.arc(250, 250, outsideRadius, angle, angle + arc, false);
    ctx.arc(250, 250, insideRadius, angle + arc, angle, true);
    ctx.fill();
    ctx.save();
    ctx.fillStyle = "#2d3748";
    ctx.translate(250, 250);
    ctx.rotate(angle + arc / 2);
    ctx.textAlign = "right";
    ctx.font = "bold 20px Noto Sans JP";
    let text = sections[i];
    if (text.length > 6) { text = text.substring(0, 5) + "..."; }
    ctx.fillText(text, textRadius, 10);
    ctx.restore();
  }
  // 中央の矢印表示
  ctx.fillStyle = "#2d3748";
  ctx.beginPath();
  ctx.moveTo(250 - 10, 250 - (outsideRadius + 20));
  ctx.lineTo(250 + 10, 250 - (outsideRadius + 20));
  ctx.lineTo(250, 250 - (outsideRadius - 5));
  ctx.closePath();
  ctx.fill();
}
drawRouletteWheel();

// 線形減速計算
function linearDeceleration(t, v0, totalTime) {
  const a = v0 / totalTime;
  return Math.max(v0 - a * t, 0);
}

// ルーレット回転アニメーション
function rotateWheel() {
  spinTime += 30;
  if (spinTime >= spinTimeTotal) {
    stopRotateWheel();
    return;
  }
  const angleIncrement = linearDeceleration(spinTime, spinAngleStart, spinTimeTotal);
  startAngle += angleIncrement * Math.PI / 180;
  drawRouletteWheel();
  requestAnimationFrame(rotateWheel);
}

// 回転停止時の処理：結果の算出とサーバへの送信
function stopRotateWheel() {
  isSpinning = false;
  const degrees = startAngle * 180 / Math.PI + 90;
  const arcd = arc * 180 / Math.PI;
  const index = Math.floor((360 - (degrees % 360)) / arcd) % sections.length;
  const resultText = sections[index];
  document.getElementById("result").textContent = "結果: " + resultText;
  ws.send(JSON.stringify({ type: "saveResult", result: resultText, spinId: currentSpinId }));
  updateResultHistory();
}

// 結果履歴の更新
function updateResultHistory() {
  const historyDiv = document.getElementById("resultHistory");
  historyDiv.innerHTML = "";
  rollResults.forEach((res, idx) => {
    const p = document.createElement("p");
    p.textContent = (idx + 1) + "回目: " + res;
    historyDiv.appendChild(p);
  });
}

// ----- ルーレット実行（スピン）ボタンの処理 -----
const spinBtn = document.getElementById("spinBtn");
spinBtn.addEventListener("click", () => {
  if (!currentRoom) { alert("ルーム名を入力してください。"); return; }
  if (isSpinning || sections.length < 2) return;
  document.getElementById("result").textContent = "";
  startAngle = 0;
  spinAngleStart = Math.random() * 10 + 10;
  spinTime = 0;
  spinTimeTotal = Math.random() * 1000 + 12000;
  const scheduledStartTime = Date.now() + 500;
  const spinId = Date.now().toString();
  currentSpinId = spinId;
  ws.send(JSON.stringify({
    type: "spin",
    spinData: { spinAngleStart, spinTimeTotal, scheduledStartTime, spinId: spinId }
  }));
});

// ----- ユーティリティ関数 ----- 
function fadeIn(element) { element.classList.add("fade-in"); }

function fallbackCopyTextToClipboard(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.top = "-9999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    const successful = document.execCommand("copy");
    if (successful) { showCopyMessage(); }
    else { alert("コピーに失敗しました。"); }
  } catch (err) { alert("コピーに失敗しました。"); }
  document.body.removeChild(textArea);
}

function showCopyMessage() {
  let copyMessage = document.getElementById("copyMessage");
  if (!copyMessage) {
    copyMessage = document.createElement("span");
    copyMessage.id = "copyMessage";
    copyMessage.style.marginLeft = "0.5rem";
    copyMessage.style.color = "green";
    document.getElementById("shareArea").appendChild(copyMessage);
  }
  copyMessage.textContent = "URLをコピーしました";
  setTimeout(() => { copyMessage.textContent = ""; }, 2000);
}
