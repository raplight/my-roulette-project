// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = 3000;
app.use(express.static('public')); // publicフォルダ内の静的ファイルを配信

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// SQLite データベース接続（database.sqlite がなければ自動生成）
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('SQLite接続エラー:', err);
  } else {
    console.log('SQLiteに接続しました:', dbPath);
  }
});

// archived_rooms テーブルを作成（ルーム情報のアーカイブ用）
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS archived_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roomName TEXT UNIQUE NOT NULL,
      rouletteParameters TEXT, -- JSON文字列で保存（パラメータと結果を含む）
      archivedAt INTEGER,      -- タイムスタンプ
      expireAt INTEGER         -- 24時間後のタイムスタンプ
    )
  `);
});

// ルーム管理：各ルームは { clients: [client1, client2, ...], rouletteParameters: [], rollResults: [] } の形式
let rooms = {};
// ルームに未所属の待機クライアント
let lobby = [];

// 24時間(ミリ秒換算)
const TTL_24H = 24 * 60 * 60 * 1000;

wss.on('connection', (ws) => {
  ws.id = Date.now().toString() + "_" + Math.floor(Math.random() * 1000);
  ws.username = "Guest_" + ws.id;
  ws.room = null;
  console.log(`[${ws.username}] が接続されました`);

  // 接続時はロビーに追加
  lobby.push(ws);
  broadcastLobby();

  ws.on('message', (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.error("メッセージパースエラー:", e);
      return;
    }

    if (msg.type === "setUsername") {
      ws.username = msg.username;
      broadcastLobby();
    }
    else if (msg.type === "joinRoom") {
      // joinRoom 時、受信したusernameで更新
      if (msg.username) {
        ws.username = msg.username;
      }
      // ロビーから削除
      lobby = lobby.filter(client => client !== ws);
      const roomName = msg.room;
      // もしアーカイブ済みルームがあれば復元
      restoreArchivedRoom(roomName, (archivedData) => {
        if (!rooms[roomName]) {
          rooms[roomName] = { clients: [], rouletteParameters: [], rollResults: [] };
        }
        // 復元があれば設定と結果を上書き
        if (archivedData) {
          if (archivedData.parameters) {
            rooms[roomName].rouletteParameters = archivedData.parameters;
          }
          if (archivedData.rollResults) {
            rooms[roomName].rollResults = archivedData.rollResults;
          }
        }
        ws.room = roomName;
        rooms[roomName].clients.push(ws);
        // ルームに参加したクライアントには、既存の設定と結果があれば送信
        if (rooms[roomName].rouletteParameters.length > 0) {
          ws.send(JSON.stringify({ type: "updateParameters", parameters: rooms[roomName].rouletteParameters }));
        }
        if (rooms[roomName].rollResults && rooms[roomName].rollResults.length > 0) {
          ws.send(JSON.stringify({ type: "updateResults", results: rooms[roomName].rollResults }));
        }
        ws.send(JSON.stringify({ type: "roomJoined", room: roomName }));
        broadcastRoom(roomName);
      });
    }
    else if (msg.type === "spin") {
      // スピン発起者を記録
      if (ws.room && rooms[ws.room]) {
        rooms[ws.room].spinInitiator = ws.id;
        // ルーレット回転情報を同じルーム内の全クライアントにブロードキャスト
        rooms[ws.room].clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ 
              type: "spin", 
              spinData: msg.spinData, 
              spunBy: ws.username 
            }));
          }
        });
      }
    }
    else if (msg.type === "updateParameters") {
      // ルーレット設定の更新内容を保存し、同じルーム内にブロードキャスト
      if (ws.room && rooms[ws.room]) {
        rooms[ws.room].rouletteParameters = msg.parameters;
        rooms[ws.room].clients.forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ 
              type: "updateParameters", 
              parameters: msg.parameters 
            }));
          }
        });
      }
    }
    else if (msg.type === "saveResult") {
      // ルーレットのスピン結果を、スピン発起者からのみ保存し、同じルーム内にブロードキャスト
      if (ws.room && rooms[ws.room]) {
        // 発起者以外からの結果は無視する
        if (rooms[ws.room].spinInitiator !== ws.id) {
          console.log(`saveResult を無視しました: 発起者ではない (${ws.id})`);
          return;
        }
        if (!rooms[ws.room].rollResults) {
          rooms[ws.room].rollResults = [];
        }
        rooms[ws.room].rollResults.push(msg.result);
        // 結果保存後、発起者情報をクリア
        rooms[ws.room].spinInitiator = null;
        rooms[ws.room].clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "updateResults", results: rooms[ws.room].rollResults }));
          }
        });
      }
    }
    else if (msg.type === "resetResult") {
      // リセット時にルーム内のスピン結果をクリアし、全クライアントへ通知するとともに、アーカイブされているデータがあれば削除
      if (ws.room && rooms[ws.room]) {
        rooms[ws.room].rollResults = [];
        rooms[ws.room].spinInitiator = null;
        rooms[ws.room].clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "updateResults", results: [] }));
          }
        });
        db.run(`DELETE FROM archived_rooms WHERE roomName = ?`, [ws.room], function(err) {
          if (err) {
            console.error("リセット時のアーカイブ削除エラー:", err);
          } else {
            console.log(`ルーム [${ws.room}] のアーカイブ結果をリセットしました`);
          }
        });
      }
    }
    else if (msg.type === "userLeft") {
      // ユーザー退出通知（クライアントからの明示的な通知）
      handleUserLeft(ws);
    }
  });

  ws.on('close', () => {
    console.log(`[${ws.username}] の接続が切断されました`);
    lobby = lobby.filter(client => client !== ws);
    if (ws.room && rooms[ws.room]) {
      rooms[ws.room].clients = rooms[ws.room].clients.filter(client => client !== ws);
      // ルームに残っているユーザーがいない場合
      if (rooms[ws.room].clients.length === 0) {
        // 保存処理：退出時の情報（設定と結果）を SQLite に保存し、24時間後に削除するタイマーをセット
        archiveRoom(ws.room, rooms[ws.room].rouletteParameters, rooms[ws.room].rollResults);
        // メモリ上からは削除
        delete rooms[ws.room];
      } else {
        broadcastRoom(ws.room);
      }
    }
    broadcastLobby();
  });
});

// ユーザー退出時の処理（クライアントからの userLeft イベント用）
function handleUserLeft(ws) {
  if (ws.room && rooms[ws.room]) {
    rooms[ws.room].clients = rooms[ws.room].clients.filter(client => client !== ws);
    if (rooms[ws.room].clients.length === 0) {
      archiveRoom(ws.room, rooms[ws.room].rouletteParameters, rooms[ws.room].rollResults);
      delete rooms[ws.room];
    } else {
      broadcastRoom(ws.room);
    }
  }
  lobby = lobby.filter(client => client !== ws);
  broadcastLobby();
}

// ロビー情報を全待機中クライアントに送信
function broadcastLobby() {
  const lobbyList = lobby.map(ws => ({ id: ws.id, username: ws.username }));
  const message = JSON.stringify({ type: "lobbyList", lobby: lobbyList });
  lobby.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// ルーム内情報（参加者一覧）をルーム内全員に送信
function broadcastRoom(roomId) {
  if (!rooms[roomId]) return;
  const roomClients = rooms[roomId].clients.map(ws => ({ id: ws.id, username: ws.username }));
  const message = JSON.stringify({ type: "roomInfo", room: roomId, clients: roomClients });
  rooms[roomId].clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// ルームが空になったときに情報をSQLiteへ保存（archived_rooms テーブルへ）
// parameters と rollResults の両方を保存
function archiveRoom(roomName, parameters, rollResults) {
  const now = Date.now();
  const expireAt = now + TTL_24H;
  const archiveData = JSON.stringify({ parameters: parameters, rollResults: rollResults });
  db.run(`
    INSERT OR REPLACE INTO archived_rooms (roomName, rouletteParameters, archivedAt, expireAt)
    VALUES (?, ?, ?, ?)
  `, [roomName, archiveData, now, expireAt], function(err) {
    if (err) {
      console.error("ルームのアーカイブ保存エラー:", err);
    } else {
      console.log(`ルーム [${roomName}] の情報をアーカイブしました（24時間保持）`);
    }
  });
  // 24時間後にこのレコードを削除するタイマー（※サーバー再起動時は再設定が必要）
  setTimeout(() => {
    db.run(`DELETE FROM archived_rooms WHERE roomName = ?`, [roomName], function(err) {
      if (err) {
        console.error("アーカイブ削除エラー:", err);
      } else {
        console.log(`ルーム [${roomName}] のアーカイブ情報を削除しました`);
      }
    });
  }, TTL_24H);
}

// ルーム参加時に、既にアーカイブ済みのルーム情報があれば復元する
function restoreArchivedRoom(roomName, callback) {
  db.get(`SELECT rouletteParameters FROM archived_rooms WHERE roomName = ?`, [roomName], (err, row) => {
    if (err) {
      console.error("ルーム情報復元エラー:", err);
      return callback(null);
    }
    if (row) {
      // 復元後はアーカイブから削除する
      db.run(`DELETE FROM archived_rooms WHERE roomName = ?`, [roomName], (err2) => {
        if (err2) {
          console.error("ルーム復元後の削除エラー:", err2);
        }
      });
      try {
        const data = JSON.parse(row.rouletteParameters);
        return callback(data);
      } catch (e) {
        console.error("ルームパラメータのパースエラー:", e);
        return callback(null);
      }
    } else {
      callback(null);
    }
  });
}

server.listen(port, () => {
  console.log(`HTTPサーバーが http://localhost:${port}/roulette.html で稼働中です`);
});
