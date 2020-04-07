/*jslint bitwise: true, node: true */
'use strict';

var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var SAT = require('sat');
var sql = require ("mysql");

// Import game settings.
var c = require('../../config.json');

// Import utilities.
var util = require('./lib/util');

// Import quadtree.
var QuadTree = require('simple-quadtree');
const shortid = require('shortid');

//call sqlinfo
var s = c.sqlinfo;

var tree = QuadTree(0, 0, c.gameWidth, c.gameHeight, { maxchildren: 10 });

var users = [];
var massFood = [];
var foodArray = [];
var foodTree = QuadTree(0, 0, c.gameWidth, c.gameHeight, { maxchildren: 10 });
var virus = [];
var sockets = {};

var leaderboard = [];
var leaderboardChanged = false;

var V = SAT.Vector;
var C = SAT.Circle;

C.prototype.boundingBoxAsSearchArea = function () {
    var diameter = this.r * 2;
    return {
        x: this.pos.x - this.r,
        y: this.pos.y - this.r,
        w: diameter,
        h: diameter
    };
};

if(s.host !== "DEFAULT") {
    var pool = sql.createConnection({
        host: s.host,
        user: s.user,
        password: s.password,
        database: s.database
    });

    //log sql errors
    pool.connect(function(err){
        if (err){
            console.log (err);
        }
    });
}

var initMassLog = util.log(c.defaultPlayerMass, c.slowBase);

app.use(express.static(__dirname + '/../client'));

function logDebug(level, anything) {
    if (c.debugLevel >= level) {
        var anyArgs = Array.prototype.slice.call(arguments, 1);
        console.log.apply(console, anyArgs);
    }
}

function addFood(toAdd) {
    var radius = util.massToRadius(c.foodMass);
    while (toAdd--) {
        var position = c.foodUniformDisposition ? util.uniformPosition(foodArray, radius) : util.randomPosition(radius);
        var newFood = {
            id: 'F.' + shortid.generate(),
            num: foodArray.length,
            x: position.x,
            y: position.y,
            w: 0,
            h: 0,
            radius: radius,
            mass: Math.random() + 2,
            hue: Math.round(Math.random() * 360)
        };
        foodArray.push(newFood);
        foodTree.put(newFood);
    }
}

function addVirus(toAdd) {
    while (toAdd--) {
        var mass = util.randomInRange(c.virus.defaultMass.from, c.virus.defaultMass.to, true);
        var radius = util.massToRadius(mass);
        var position = c.virusUniformDisposition ? util.uniformPosition(virus, radius) : util.randomPosition(radius);
        virus.push({
            id: ((new Date()).getTime() + '' + virus.length) >>> 0,
            x: position.x,
            y: position.y,
            radius: radius,
            mass: mass
        });
    }
}

function removeFood(toRem) {
    while (toRem--) {
        var f = foodArray.pop();
        foodTree.remove(f, 'id');
    }
}

function movePlayer(player) {
    if (player.type === "spectate") {
        return;
    }
    for(var i=0; i<player.cells.length; i++)
    {
        var cell = player.cells[i];

        var deltaY, deltaX;

        if (cell.speed > 6.25 && (cell.moveY || cell.moveX) && cell.slowDownStep) {
            deltaY = cell.speed * cell.moveY;
            deltaX = cell.speed * cell.moveX;
            cell.speed -= cell.slowDownStep;
        } else {
            if (cell.moveY || cell.moveX || cell.slowDownStep) {
                delete cell.moveX;
                delete cell.moveY;
                delete cell.slowDownStep;
            }
            var target = {
                x: player.x - cell.x + player.target.x,
                y: player.y - cell.y + player.target.y
            };
            var angle = Math.atan2(target.y, target.x);

            var slowDown = 1;
            if (cell.speed <= 6.25) {
                slowDown = util.log(cell.mass, c.slowBase) - initMassLog + 1;
            }

            deltaY = cell.speed * Math.sin(angle) / slowDown;
            deltaX = cell.speed * Math.cos(angle) / slowDown;

            if (cell.speed > 6.25) {
                cell.speed -= 0.5;
            }

            var fenceDist = 50 + cell.radius,
                dist = Math.sqrt(target.y * target.y + target.x * target.x);
            if (dist < fenceDist) {
                deltaY *= dist / fenceDist;
                deltaX *= dist / fenceDist;
            }
        }

        if (!isNaN(deltaY)) {
            player.cells[i].y += deltaY;
        }
        if (!isNaN(deltaX)) {
            player.cells[i].x += deltaX;
        }
        // Find best solution.
        if (cell.moveX || cell.moveY) {
            // logDebug(3, "[TRACE] movePlayer(): ignoring push away for cell #[" + i + "] with speed=[" + cell.speed + "]");
        } else {
            for(var j=0; j<player.cells.length; j++) {
                if(j != i && player.cells[i] !== undefined) {
                    // logDebug(3, "[TRACE] movePlayer(): about to push away cell #[" + i + "] away from other cell #[" + j + "]");

                    var otherCell = player.cells[j];
                    var pushAway = new V(cell.x - otherCell.x, cell.y - otherCell.y);
                    var distance = pushAway.len();
                    var radiusTotal = (cell.radius + otherCell.radius);

                    if(distance < radiusTotal) {
                        if (otherCell.moveX || otherCell.moveY) {
                            // logDebug(3, "[TRACE] movePlayer(): cell #[" + i + "] ignoring push away from cell #[" + j + "] with speed=[" + otherCell.speed + "]");
                            continue;
                        }
                        else if(player.lastSplit > new Date().getTime() - 1000 * c.mergeTimer) {
                            // NOTA: we could divide by 'distance' instead of
                            // using '.normalize()', but then we would have to
                            // care if distance > 0
                            pushAway.normalize().scale((radiusTotal - distance) * cell.pushAwayFactor * otherCell.pushAwayFactor);
                            // pushAway.normalize();
                            cell.x += pushAway.x;
                            cell.y += pushAway.y;
                        }
                        else if (cell.mass >= otherCell.mass && distance < cell.radius - otherCell.radius * 0.7) {
                            // logDebug(3, "[TRACE] movePlayer(): about to merge other cell #[" + j + "] into cell #[" + i + "]");
                            player.cells[i].mass += player.cells[j].mass;
                            player.cells[i].radius = util.massToRadius(player.cells[i].mass);
                            player.cells.splice(j, 1);
                            if (j < i) {
                                i -= 1;
                            }
                            for (var idx = j; idx < player.cells.length; idx++) {
                                player.cells[idx].num = idx;
                            }
                            j -= 1;
                            // logDebug(3, "[TRACE] movePlayer(): merged cells. i=[" + i + "], j=[" + j + "]");
                        }
                    }
                }
            }
            if (cell.pushAwayFactor < 1.0) {
                cell.pushAwayFactor += c.pushAwayFactorStep;
            } else if (cell.pushAwayFactor > 1.0) {
                cell.pushAwayFactor = 1.0;
            }
        }
        if(player.cells.length > i) {
            // logDebug(3, "[TRACE] movePlayer(): aout to clip coordinates for cell #[" + i + "]");
            var borderCalc = player.cells[i].radius / 3;
            if (player.cells[i].x > c.gameWidth - borderCalc) {
                player.cells[i].x = c.gameWidth - borderCalc;
            }
            if (player.cells[i].y > c.gameHeight - borderCalc) {
                player.cells[i].y = c.gameHeight - borderCalc;
            }
            if (player.cells[i].x < borderCalc) {
                player.cells[i].x = borderCalc;
            }
            if (player.cells[i].y < borderCalc) {
                player.cells[i].y = borderCalc;
            }
        }
    }


    // Compute player viewpoint, as the barycenter of the resulting cells positions
    var viewCenter = new V(),
        bounds = { minX: c.gameWidth, minY: c.gameHeight, maxX: 0, maxY: 0 };
    var initialCellsCount = player.cells.length;
    for (var cellIdx = 0; cellIdx < initialCellsCount; cellIdx++) {
        var cell_ = player.cells[cellIdx];
        // logDebug(3, "[TRACE] movePlayer(): computing viewpoint: cellIdx=[" + cellIdx + "], cell_.x=[" + cell_.x + "], cell_.y=[" + cell_.y + "]");
        viewCenter.x += cell_.x;
        viewCenter.y += cell_.y;

        bounds.minX = Math.min(bounds.minX, cell_.x - cell_.radius);
        bounds.minY = Math.min(bounds.minY, cell_.y - cell_.radius);
        bounds.maxX = Math.max(bounds.maxX, cell_.x + cell_.radius);
        bounds.maxY = Math.max(bounds.maxY, cell_.y + cell_.radius);
    }
    player.x = viewCenter.x / initialCellsCount;
    player.y = viewCenter.y / initialCellsCount;
    // logDebug(2, "[DEBUG] movePlayer(): viewpoint computed. initialCellsCount=[" + initialCellsCount + "], player.x=[" + player.x + "], player.y=[" + player.y + "]");

    var spanX = (bounds.maxX - bounds.minX) * 1.4,
        spanY = (bounds.maxY - bounds.minY) * 1.4,
        aspectRatio = player.screenWidth / player.screenHeight;

    player.viewZoom = Math.max(c.minViewZoom, spanX, spanX / aspectRatio, spanY, spanY * aspectRatio);
}

function moveMass(mass) {
    var deg = Math.atan2(mass.target.y, mass.target.x);
    var deltaY = mass.speed * Math.sin(deg);
    var deltaX = mass.speed * Math.cos(deg);

    mass.speed -= 0.5;
    if(mass.speed < 0) {
        mass.speed = 0;
    }
    if (!isNaN(deltaY)) {
        mass.y += deltaY;
    }
    if (!isNaN(deltaX)) {
        mass.x += deltaX;
    }

    var borderCalc = mass.radius + 5;

    if (mass.x > c.gameWidth - borderCalc) {
        mass.x = c.gameWidth - borderCalc;
    }
    if (mass.y > c.gameHeight - borderCalc) {
        mass.y = c.gameHeight - borderCalc;
    }
    if (mass.x < borderCalc) {
        mass.x = borderCalc;
    }
    if (mass.y < borderCalc) {
        mass.y = borderCalc;
    }
}

function balanceMass() {
    var totalMass = foodArray.length * c.foodMass +
        users
            .map(function(u) {return u.massTotal; })
            .reduce(function(pu,cu) { return pu+cu;}, 0);

    var massDiff = c.gameMass - totalMass;
    var maxFoodDiff = c.maxFood - foodArray.length;
    var foodDiff = parseInt(massDiff / c.foodMass) - maxFoodDiff;
    var foodToAdd = Math.min(foodDiff, maxFoodDiff);
    var foodToRemove = -Math.max(foodDiff, maxFoodDiff);

    if (foodToAdd > 0) {
        // logDebug(2, '[DEBUG] Adding ' + foodToAdd + ' food to level!');
        addFood(foodToAdd);
        // logDebug(2, '[DEBUG] Mass rebalanced!');
    }
    else if (foodToRemove > 0) {
        // logDebug(2, '[DEBUG] Removing ' + foodToRemove + ' food from level!');
        removeFood(foodToRemove);
        // logDebug(2, '[DEBUG] Mass rebalanced!');
    }

    var virusToAdd = c.maxVirus - virus.length;

    if (virusToAdd > 0) {
        addVirus(virusToAdd);
    }
}

function explodeCell(currentPlayer, cell, virus) {
   function explode(cell) {
        if (cell.mass >= c.defaultPlayerMass * 4) {
            var remainingCellsCount = c.limitSplit - currentPlayer.cells.length;
            if (remainingCellsCount <= 0) {
                return; // Already divided into too manyparts: just eat the virus
            }
            var partsMass = c.defaultPlayerMass * 2,
                partsCount = Math.min(Math.max(0, Math.floor(cell.mass / partsMass) - 2), remainingCellsCount),
                splitAfterExplode = 0;
            // logDebug(2, "[DEBUG] explode(): (1) partsMass=[" + partsMass + "], cell.mass=[" + Math.floor(cell.mass) + "], remainingCellsCount=[" + remainingCellsCount + "], partsCount=[" + partsCount + "]");
            if ((cell.mass - partsMass * partsCount) > 6 * partsMass) {
                partsMass = c.defaultPlayerMass * 3;
                partsCount = Math.min(Math.max(0, Math.floor(cell.mass / partsMass) - 2), remainingCellsCount);
            }
            // logDebug(2, "[DEBUG] explode(): (2) partsMass=[" + partsMass + "], cell.mass=[" + Math.floor(cell.mass) + "], remainingCellsCount=[" + remainingCellsCount + "], partsCount=[" + partsCount + "]");
            while (splitAfterExplode < 3 && ((cell.mass - partsMass * partsCount) / Math.pow(2, splitAfterExplode) > 8 * partsMass) && (partsCount > 8)) {
                splitAfterExplode += 1;
                partsCount -= Math.pow(2, splitAfterExplode - 1);
                // logDebug(2, "[DEBUG] explode(): (3) partsMass=[" + partsMass + "], cell.mass=[" + Math.floor(cell.mass) +
                //     "], remainingCellsCount=[" + remainingCellsCount + "], partsCount=[" + partsCount +
                //     "], ((cell.mass - partsMass * partsCount) / Math.pow(2, splitAfterExplode)=[" + ((cell.mass - partsMass * partsCount) / Math.pow(2, splitAfterExplode)) +
                //     "], (6 * partsMass)=[" + (6 * partsMass) + "]");
            }

            var partsRadius = util.massToRadius(partsMass);


            var playerMove = {
                    x: currentPlayer.x - cell.x + currentPlayer.target.x,
                    y: currentPlayer.y - cell.y + currentPlayer.target.y
                },
                playerAngle = Math.atan2(playerMove.y, playerMove.x),
                partAngle;

            var idx;
            for (idx = 0; idx < partsCount; idx++) {
                partAngle = playerAngle + 2 * Math.PI * idx / partsCount;
                cell.mass -= partsMass;
                currentPlayer.cells.push({
                    id: currentPlayer.id,
                    num: currentPlayer.cells.length,
                    mass: partsMass,
                    x: virus.x,
                    y: virus.y,
                    w: 0,
                    h: 0,
                    radius: partsRadius,
                    speed: 20,
                    moveX: Math.cos(partAngle),
                    moveY: Math.sin(partAngle),
                    slowDownStep: c.explodeSlowdownStep,
                    pushAwayFactor: 0.0
                });
            }
            cell.radius = util.massToRadius(cell.mass);
            var splitCandidates = [ cell ];
            // logDebug(2, "[DEBUG] explode(): splitting cells splitAfterExplode=[" + splitAfterExplode + "], splitCandidates.length=[" + splitCandidates.length + "]");
            while (--splitAfterExplode >= 0) {
                // logDebug(2, "[DEBUG] explode(): splitting cells splitAfterExplode=[" + splitAfterExplode + "], splitCandidates.length=[" + splitCandidates.length + "]");
                var initialCandidatesCount = splitCandidates.length;
                for (idx = 0; idx < initialCandidatesCount; idx++) {
                    doSplitCell(currentPlayer, splitCandidates[idx], cell.speed);
                    splitCandidates.push(currentPlayer.cells[currentPlayer.cells.length - 1]);
                }
            }
        }
        // logDebug(2, "[DEBUG] explode(): returning");
    }

    // logDebug(2, "[DEBUG] explodeCell(): currentPlayer.cells.length=[" + currentPlayer.cells.length + "]");

    if (currentPlayer.cells.length >= c.limitSplit) {
        return; // Already divided into too manyparts: just eat the virus
    }
    if (currentPlayer.massTotal < c.defaultPlayerMass * 4) {
        return; // can't make two parts of twice the default mass: abort
    }

    explode(cell);
    currentPlayer.lastSplit = new Date().getTime();
    // logDebug(2, "[DEBUG] explodeCell(): returning");
}

function doSplitCell(currentPlayer, cell, alternateSpeed, slowDownStep) {
    var speed = alternateSpeed ? alternateSpeed : 25;
    var slowDown = slowDownStep ? slowDownStep : c.splitSlowdownStep;
     if (cell.mass >= c.defaultPlayerMass * 2) {
        cell.mass = cell.mass / 2;
        cell.radius = util.massToRadius(cell.mass);
        var newCell = {
            id: currentPlayer.id,
            num: currentPlayer.cells.length,
            mass: cell.mass,
            x: cell.x,
            y: cell.y,
            w: 0,
            h: 0,
            radius: cell.radius,
            speed: speed,
            pushAwayFactor: 0.0
        };
        if (speed > 6.25) {
            var move = new V(currentPlayer.target.x, currentPlayer.target.y).normalize();
            newCell.moveX = move.x;
            newCell.moveY = move.y;
            newCell.slowDownStep = slowDown;
        }
        currentPlayer.cells.push(newCell);
    }
}

function splitCell(currentPlayer) {

    if (currentPlayer.cells.length >= c.limitSplit) {
        return; // Already divided into too manyparts: refuse to split
    }
    if (currentPlayer.massTotal < c.defaultPlayerMass * 2) {
        return; // can't make two parts of default mass: abort
    }

    var initialCellsCount = currentPlayer.cells.length;
    for (var idx = 0; idx < initialCellsCount; idx++) {
        doSplitCell(currentPlayer, currentPlayer.cells[idx]);
    }
    currentPlayer.lastSplit = new Date().getTime();
}

io.on('connection', function (socket) {
    console.log('A user connected!', socket.handshake.query.type);

    var type = socket.handshake.query.type;
    var radius = util.massToRadius(c.defaultPlayerMass);
    var position = c.newPlayerInitialPosition == 'farthest' ? util.uniformPosition(users, radius) : util.randomPosition(radius);

    var cells = [];
    var massTotal = 0;
    if(type === 'player') {
        cells = [{
            id: socket.id,
            num: 0,
            mass: c.defaultPlayerMass,
            x: position.x,
            y: position.y,
            w: 0,
            h: 0,
            radius: radius,
            speed: 6.25,
            pushAwayFactor: 1.0
        }];
        massTotal = c.defaultPlayerMass;
    }

    var currentPlayer = {
        id: socket.id,
        x: position.x,
        y: position.y,
        cells: cells,
        massTotal: massTotal,
        hue: Math.round(Math.random() * 360),
        type: type,
        lastHeartbeat: new Date().getTime(),
        target: {
            x: 0,
            y: 0
        },
        viewZoom: c.minViewZoom
    };

    socket.on('gotit', function (player) {
        console.log('[INFO] Player ' + player.name + ' connecting!');

        if (util.findIndex(users, player.id) > -1) {
            console.log('[INFO] Player ID is already connected, kicking.');
            socket.disconnect();
        } else if (!util.validNick(player.name)) {
            socket.emit('kick', 'Invalid username.');
            socket.disconnect();
        } else {
            console.log('[INFO] Player ' + player.name + ' connected!');
            sockets[player.id] = socket;

            var radius = util.massToRadius(c.defaultPlayerMass);
            var position = c.newPlayerInitialPosition == 'farthest' ? util.uniformPosition(users, radius) : util.randomPosition(radius);

            player.x = position.x;
            player.y = position.y;
            player.target.x = 0;
            player.target.y = 0;
            if(type === 'player') {
                player.cells = [{
                    id: player.id,
                    num: 0,
                    mass: c.defaultPlayerMass,
                    x: position.x,
                    y: position.y,
                    w: 0,
                    h: 0,
                    radius: radius,
                    speed: 6.25,
                    pushAwayFactor: 1.0
                }];
                player.massTotal = c.defaultPlayerMass;
            }
            else { // spectator
                 player.cells = [];
                 player.massTotal = 0;
                player.x = c.gameWidth / 2;
                player.y = c.gameHeight / 2;
                player.viewZoom = Math.max(c.gameWidth, c.gameHeight);
            }
            player.hue = Math.round(Math.random() * 360);
            currentPlayer = player;
            currentPlayer.lastHeartbeat = new Date().getTime();
            users.push(currentPlayer);

            io.emit('playerJoin', { name: currentPlayer.name });

            socket.emit('gameSetup', {
                gameWidth: c.gameWidth,
                gameHeight: c.gameHeight
            });
            console.log('[INFO] Total players: ' + users.length);
        }

    });

    socket.on('pingcheck', function () {
        socket.emit('pongcheck');
    });

    socket.on('windowResized', function (data) {
        currentPlayer.screenWidth = data.screenWidth;
        currentPlayer.screenHeight = data.screenHeight;
    });

    socket.on('respawn', function () {
        if (util.findIndex(users, currentPlayer.id) > -1)
            users.splice(util.findIndex(users, currentPlayer.id), 1);
        socket.emit('welcome', currentPlayer);
        console.log('[INFO] User ' + currentPlayer.name + ' respawned!');
    });

    socket.on('disconnect', function () {
        if (util.findIndex(users, currentPlayer.id) > -1)
            users.splice(util.findIndex(users, currentPlayer.id), 1);
        console.log('[INFO] User ' + currentPlayer.name + ' disconnected!');

        socket.broadcast.emit('playerDisconnect', { name: currentPlayer.name });
    });

    socket.on('playerChat', function(data) {
        var _sender = data.sender.replace(/(<([^>]+)>)/ig, '');
        var _message = data.message.replace(/(<([^>]+)>)/ig, '');
        if (c.logChat === 1) {
            console.log('[CHAT] [' + (new Date()).getHours() + ':' + (new Date()).getMinutes() + '] ' + _sender + ': ' + _message);
        }
        socket.broadcast.emit('serverSendPlayerChat', {sender: _sender, message: _message.substring(0,35)});
    });

    socket.on('pass', function(data) {
        if (data[0] === c.adminPass) {
            console.log('[INFO] ' + currentPlayer.name + ' just logged in as an admin!');
            socket.emit('serverMSG', 'Welcome back ' + currentPlayer.name);
            socket.broadcast.emit('serverMSG', currentPlayer.name + ' just logged in as admin!');
            currentPlayer.admin = true;
        } else {
            
            // TODO: Actually log incorrect passwords.
              console.log('[WARN] ' + currentPlayer.name + ' attempted to log in with incorrect password.');
              socket.emit('serverMSG', 'Password incorrect, attempt logged.');
            if (s.host !== "DEFAULT") {
                pool.query('INSERT INTO logging SET name=' + currentPlayer.name + ', reason="Invalid login attempt as admin"');
            }
        }
    });

    socket.on('kick', function(data) {
        if (currentPlayer.admin) {
            var reason = '';
            var worked = false;
            for (var e = 0; e < users.length; e++) {
                if (users[e].name === data[0] && !users[e].admin && !worked) {
                    if (data.length > 1) {
                        for (var f = 1; f < data.length; f++) {
                            if (f === data.length) {
                                reason = reason + data[f];
                            }
                            else {
                                reason = reason + data[f] + ' ';
                            }
                        }
                    }
                    if (reason !== '') {
                       console.log('[INFO] User ' + users[e].name + ' kicked successfully by ' + currentPlayer.name + ' for reason ' + reason);
                    }
                    else {
                       console.log('[INFO] User ' + users[e].name + ' kicked successfully by ' + currentPlayer.name);
                    }
                    socket.emit('serverMSG', 'User ' + users[e].name + ' was kicked by ' + currentPlayer.name);
                    sockets[users[e].id].emit('kick', reason);
                    sockets[users[e].id].disconnect();
                    users.splice(e, 1);
                    worked = true;
                }
            }
            if (!worked) {
                socket.emit('serverMSG', 'Could not locate user or user is an admin.');
            }
        } else {
            console.log('[WARN] ' + currentPlayer.name + ' is trying to use -kick but isn\'t an admin.');
            socket.emit('serverMSG', 'You are not permitted to use this command.');
        }
    });

    socket.on('var', function(data) {
        if (c.debugLevel <= 0) {
            console.log("[WARN] player [" + currentPlayer.name + "] is trying to set variable," +
                "but debug mode is disabled on this server, with debugLevel=[" + c.debugLevel + "].");
            return;
        }
        if (!currentPlayer.admin) {
            console.log("[WARN] player [" + currentPlayer.name + "] is trying to set variable, but isn't an admin.");
            socket.emit('serverMSG', 'You are not permitted to use this command.');
            return;
        }
        var varName, varValue, numericValue;
        if (data.length > 1) {
            varName = data[0];
            varValue = data[1];
            numericValue = Number(varValue);
            if (!isNaN(numericValue)) {
                varValue = numericValue;
            }
            console.log('[INFO] ' + currentPlayer.name + ' setvar [' + varName + '] to [' + varValue + '] (' + typeof varValue + ')');
            socket.emit('serverMSG', 'setvar [' + varName + '] to [' + varValue + '] (' + typeof varValue + ')');
            if (varName === "mass") {
                var addedMass = varValue - currentPlayer.massTotal,
                    firstCell = currentPlayer.cells[0];
                firstCell.mass += addedMass;
                firstCell.radius = util.massToRadius(firstCell.mass);
                currentPlayer.massTotal += addedMass;
            } else if (currentPlayer.hasOwnProperty(varName)) {
                currentPlayer[varName] = varValue;
            } else {
                c[varName] = varValue;
            }
        } else {
            varName = data[0];
            if (varName === "mass") {
                varValue = currentPlayer.massTotal;
            } else if (currentPlayer.hasOwnProperty(varName)) {
                varValue = currentPlayer[varName];
            } else {
                varValue = c[varName];
            }
            // Truncate to only 4 digits after fractional part, if necessary
            var approx = false;
            if (typeof varValue === "number") {
                var fraction = String(varValue - (~~varValue)),
                    fractionDigits = fraction.length - fraction.indexOf(".") - 1;
                if (fractionDigits > 4) {
                    varValue = Math.round(varValue * 10000) / 10000;
                    approx = true;
                }
            }
            console.log('[INFO] ' + currentPlayer.name + ' getvar [' + varName + '] => [' + (approx ? "≈" : "") + varValue + '] (' + typeof varValue + ')');
            socket.emit('serverMSG', 'getvar [' + varName + '] is [' + (approx ? "≈" : "") + varValue + '] (' + typeof varValue + ')');
        }
    });

    // Heartbeat function, update everytime.
    socket.on('0', function(target) {
        currentPlayer.lastHeartbeat = new Date().getTime();
        if (target.x !== currentPlayer.x || target.y !== currentPlayer.y) {
            currentPlayer.target = target;
        }
    });

    socket.on('1', function() {
        // Fire food.
        for(var i=0; i<currentPlayer.cells.length; i++)
        {
            if(((currentPlayer.cells[i].mass >= c.defaultPlayerMass + c.fireFood) && c.fireFood > 0) || (currentPlayer.cells[i].mass >= 20 && c.fireFood === 0)){
                var masa = 1;
                if(c.fireFood > 0)
                    masa = c.fireFood;
                else
                    masa = currentPlayer.cells[i].mass*0.1;
                currentPlayer.cells[i].mass -= masa;
                currentPlayer.massTotal -=masa;
                massFood.push({
                    id: currentPlayer.id,
                    num: i,
                    masa: masa,
                    hue: currentPlayer.hue,
                    target: {
                        x: currentPlayer.x - currentPlayer.cells[i].x + currentPlayer.target.x,
                        y: currentPlayer.y - currentPlayer.cells[i].y + currentPlayer.target.y
                    },
                    x: currentPlayer.cells[i].x,
                    y: currentPlayer.cells[i].y,
                    radius: util.massToRadius(masa),
                    speed: 25
                });
            }
        }
    });

    socket.on('2', function() {
        splitCell(currentPlayer);
    });
});

function tickPlayer(currentPlayer) {
    if(currentPlayer.lastHeartbeat < new Date().getTime() - c.maxHeartbeatInterval) {
        sockets[currentPlayer.id].emit('kick', 'Last heartbeat received over ' + c.maxHeartbeatInterval + 'ms ago.');
        sockets[currentPlayer.id].disconnect();
    }

    movePlayer(currentPlayer);

    function eatFood(food) {
        if (SAT.pointInCircle(food, cellCircle)) {
            foodArray.splice(food.num, 1);
            for (var idx = food.num; idx < foodArray.length; idx += 1) {
                foodArray[idx].num = idx;
            }
            foodTree.remove(food, 'id');
            masaGanada += c.foodMass;
        }
    }

    function funcFood(f) {
        return SAT.pointInCircle(new V(f.x, f.y), cellCircle);
    }

    function eatMass(m) {
        if(SAT.pointInCircle(new V(m.x, m.y), cellCircle)){
            if(m.id == currentPlayer.id && m.speed > 0 && z == m.num)
                return false;
            if(currentCell.mass > m.masa * 1.1)
                return true;
        }
        return false;
    }

    function check(cell) {
        if (cell.mass > 10 && cell.id !== currentPlayer.id) {
            var response = new SAT.Response();
            var collided = SAT.testCircleCircle(cellCircle,
                new C(new V(cell.x, cell.y), cell.radius),
                response);
            if (collided) {
                response.aUser = currentCell;
                response.bUser = cell;
                playerCollisions.push(response);
            }
        }
        return true; // continue iterating in the quadtree
    }

    function collisionCheck(collision) {
        if (collision.aUser.mass < (collision.bUser.mass * 1.1)) {
            return;
        }
        var distance = new V(collision.aUser.x - collision.bUser.x, collision.aUser.y - collision.bUser.y).len();
        var radiusDifference = collision.aUser.radius - collision.bUser.radius * 0.7;
        // logDebug(3, '[TRACE] candidate collision with user: [' + collision.bUser.id +
        //     '], distance=' + distance +
        //     ', collision.bUser.radius * 0.7 =' + (collision.bUser.radius * 0.7) +
        //     ', radius_difference=' + radiusDifference +
        //     ', bInA=' + collision.bInA);

        if (collision.bInA || (distance < radiusDifference)) {
            logDebug(1, '[DEBUG] Killing user: ' + collision.bUser.id);
            logDebug(1, '[DEBUG] Collision info:');
            logDebug(1, collision);

            var numUser = util.findIndex(users, collision.bUser.id);
            if (numUser > -1) {
                if(users[numUser].cells.length > 1) {
                    users[numUser].massTotal -= collision.bUser.mass;
                    users[numUser].cells.splice(collision.bUser.num, 1);
                    for (var idx = collision.bUser.num; idx < users[numUser].cells.length; idx++) {
                        users[numUser].cells[idx].num = idx;
                    }
                } else {
                    users.splice(numUser, 1);
                    io.emit('playerDied', { name: collision.bUser.name });
                    sockets[collision.bUser.id].emit('RIP');
                }
            }
            currentPlayer.massTotal += collision.bUser.mass;
            collision.aUser.mass += collision.bUser.mass;
        }
    }

    for(var z=0; z<currentPlayer.cells.length; z++) {
        var currentCell = currentPlayer.cells[z],
            cellCenter = new V().copy(currentCell),
            cellCircle = new C(cellCenter, currentCell.radius);

        var masaGanada = 0,
            cellBoundingBoxSearchArea = cellCircle.boundingBoxAsSearchArea();
        foodTree.get(cellBoundingBoxSearchArea).forEach(eatFood);

        var massEaten = massFood.map(eatMass)
            .reduce(function(a, b, c) {return b ? a.concat(c) : a; }, []);

        var virusCollision = virus.map(funcFood)
           .reduce( function(a, b, c) { return b ? a.concat(c) : a; }, []);

        if(virusCollision > 0 && currentCell.mass > virus[virusCollision].mass) {
            currentCell.mass += virus[virusCollision].mass / 4;
            currentPlayer.massTotal += virus[virusCollision].mass / 4;
            currentCell.radius = util.massToRadius(currentCell.mass);
            cellCircle.r = currentCell.radius;

          explodeCell(currentPlayer, currentPlayer.cells[z], virus[virusCollision]);
          virus.splice(virusCollision, 1);
        }

        for(var m=0; m<massEaten.length; m++) {
            masaGanada += massFood[massEaten[m]].masa;
            massFood.splice(massEaten[m],1);
            for(var n=0; n<massEaten.length; n++) {
                if(massEaten[m] < massEaten[n]) {
                    massEaten[n]--;
                }
            }
        }

        if(typeof(currentCell.speed) == "undefined")
            currentCell.speed = 6.25;
        currentCell.mass += masaGanada;
        currentPlayer.massTotal += masaGanada;
        currentCell.radius = util.massToRadius(currentCell.mass);
        cellCircle.r = currentCell.radius;

        tree.clear();
        for (var idx = 0; idx < users.length; idx++) {
            users[idx].cells.forEach(tree.put);
        }
        var playerCollisions = [];

        var otherCells = tree.get(cellBoundingBoxSearchArea, check);

        playerCollisions.forEach(collisionCheck);
    }
}

function moveloop() {
    for (var i = 0; i < users.length; i++) {
        tickPlayer(users[i]);
    }
    for (i=0; i < massFood.length; i++) {
        if(massFood[i].speed > 0) moveMass(massFood[i]);
    }
}

function gameloop() {
    if (users.length > 0) {
        users.sort( function(a, b) { return b.massTotal - a.massTotal; });

        var topUsers = [];

        for (var i = 0; i < Math.min(10, users.length); i++) {
            if(users[i].type == 'player') {
                topUsers.push({
                    id: users[i].id,
                    name: users[i].name
                });
            }
        }
        if (isNaN(leaderboard) || leaderboard.length !== topUsers.length) {
            leaderboard = topUsers;
            leaderboardChanged = true;
        }
        else {
            for (i = 0; i < leaderboard.length; i++) {
                if (leaderboard[i].id !== topUsers[i].id) {
                    leaderboard = topUsers;
                    leaderboardChanged = true;
                    break;
                }
            }
        }
        for (i = 0; i < users.length; i++) {
            for(var z=0; z < users[i].cells.length; z++) {
                if (users[i].cells[z].mass * (1 - (c.massLossRate / 1000)) > c.defaultPlayerMass && users[i].massTotal > c.minMassLoss) {
                    var massLoss = users[i].cells[z].mass * (1 - (c.massLossRate / 1000));
                    users[i].massTotal -= users[i].cells[z].mass - massLoss;
                    users[i].cells[z].mass = massLoss;
                }
            }
        }
    }
    balanceMass();
}

function sendUpdates() {
    users.forEach( function(u) {
        // center the view if x/y is undefined, this will happen for spectators
        u.x = u.x || c.gameWidth / 2;
        u.y = u.y || c.gameHeight / 2;

        var largestDimension = Math.max(u.screenWidth, u.screenHeight),
            viewWidth = Math.round(u.screenWidth * u.viewZoom / largestDimension),
            viewHeight = Math.round(u.screenHeight * u.viewZoom / largestDimension);

        var viewArea = {
            x: u.x - viewWidth/2,
            y: u.y - viewHeight/2,
            w: viewWidth,
            h: viewHeight
        };
        var visibleFood = foodTree.get(viewArea, 20, []);

        var visibleVirus  = virus
            .map(function(f) {
                if ( f.x > u.x - viewWidth/2 - f.radius &&
                    f.x < u.x + viewWidth/2 + f.radius &&
                    f.y > u.y - viewHeight/2 - f.radius &&
                    f.y < u.y + viewHeight/2 + f.radius) {
                    return f;
                }
            })
            .filter(function(f) { return f; });

        var visibleMass = massFood
            .map(function(f) {
                if ( f.x+f.radius > u.x - viewWidth/2 - 20 &&
                    f.x-f.radius < u.x + viewWidth/2 + 20 &&
                    f.y+f.radius > u.y - viewHeight/2 - 20 &&
                    f.y-f.radius < u.y + viewHeight/2 + 20) {
                    return f;
                }
            })
            .filter(function(f) { return f; });

        var visibleCells  = users
            .map(function(f) {
                try {
                for(var z=0; z<f.cells.length; z++)
                {
                    if ( f.cells[z].x+f.cells[z].radius > u.x - viewWidth/2 - 20 &&
                        f.cells[z].x-f.cells[z].radius < u.x + viewWidth/2 + 20 &&
                        f.cells[z].y+f.cells[z].radius > u.y - viewHeight/2 - 20 &&
                        f.cells[z].y-f.cells[z].radius < u.y + viewHeight/2 + 20) {
                        z = f.cells.lenth;
                        if(f.id !== u.id) {
                            var otherPlayer = {
                                id: f.id,
                                x: f.x,
                                y: f.y,
                                cells: f.cells,
                                massTotal: Math.round(f.massTotal),
                                hue: f.hue,
                                name: f.name,
                            };
                            if (c.debugLevel >= 2) {
                                var largestDimension = Math.max(f.screenWidth, f.screenHeight);
                                otherPlayer.viewWidth = Math.round(f.screenWidth * f.viewZoom / largestDimension);
                                otherPlayer.viewHeight = Math.round(f.screenHeight * f.viewZoom / largestDimension);
                            }
                            return otherPlayer;
                        } else {
                            //console.log("Nombre: " + f.name + " Es Usuario");
                            return {
                                x: f.x,
                                y: f.y,
                                cells: f.cells,
                                massTotal: Math.round(f.massTotal),
                                hue: f.hue,
                                viewWidth: viewWidth,
                                viewHeight: viewHeight
                            };
                        }
                    }
                }
                } catch (err) {
                    console.log("[ERROR] sendUpdates(): while computing visible cells for user [" + u.name + "]:");
                    console.log(err);
                }
            })
            .filter(function(f) { return f; });

        if (visibleCells.length <= 0 && u.type !== "spectate") {
            console.log("[ERROR] sendUpdates(): the visibleCells array is empty for user [" + u.name + "]");
        }

        sockets[u.id].emit('serverTellPlayerMove', visibleCells, visibleFood, visibleMass, visibleVirus);
        if (leaderboardChanged) {
            sockets[u.id].emit('leaderboard', {
                players: users.length,
                leaderboard: leaderboard
            });
        }
    });
    leaderboardChanged = false;
}

setInterval(moveloop, 1000 / 60);
setInterval(gameloop, 1000);
setInterval(sendUpdates, 1000 / c.networkUpdateFactor);

// Don't touch, IP configurations.
var ipaddress = process.env.OPENSHIFT_NODEJS_IP || process.env.IP || c.host;
var serverport = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || c.port;
http.listen( serverport, ipaddress, function() {
    logDebug(1, '[DEBUG] Listening on ' + ipaddress + ':' + serverport);
});
