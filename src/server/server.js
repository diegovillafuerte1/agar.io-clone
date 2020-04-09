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
var mainTree = QuadTree(0, 0, c.gameWidth, c.gameHeight, { maxchildren: 10 });
var virusArray = [];
var sockets = {};

var leaderboard = [];
var leaderboardChanged = false;

var profiling = {
    gameloop: {
        serie: [ 0 ],
        distrib: []
    },
    moveloop: {
        serie: [ 0 ],
        distrib: []
    },
    sendUpdates: {
        serie: [ 0 ],
        distrib: []
    }
};

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
        var position = util.uniformPosition(foodArray, radius, c.foodPlacementUniformityLevel);
        var newFood = {
            id: 'F.' + shortid.generate(),
            num: foodArray.length,
            x: position.x,
            y: position.y,
            w: 0,
            h: 0,
            radius: radius,
            hue: Math.round(Math.random() * 360)
        };
        foodArray.push(newFood);
        mainTree.put(newFood);
    }
}

function addVirus(maxCellRadius) {

    function anyoneNotAccepted(cell) {
        var cellCircle = new C(cell, cell.radius);
        if (SAT.testCircleCircle(cellCircle, virusCircle)) {
            accepted = false;
            return false;
        }
        return true; // continue iterating the quadtre search results
    }

    var mass = util.randomInRange(c.virus.defaultMass.from, c.virus.defaultMass.to),
        radius = util.massToRadius(mass);

    var attempts = 10,
        position, virusCircle, accepted;

    do {
        position = util.uniformPosition(virusArray, radius, c.virusPlacementUniformityLevel);
        virusCircle = new C(position, radius);
        accepted = true; // to be set to false during quadtree search
        tree.get(virusCircle.boundingBoxAsSearchArea(), maxCellRadius, anyoneNotAccepted);
    } while (!accepted && --attempts > 0);

    var newVirus = {
        id: 'V.' + shortid.generate(),
        num: virusArray.length,
        x: position.x,
        y: position.y,
        w: 0,
        h: 0,
        radius: radius,
        mass: mass
    };
    virusArray.push(newVirus);
    mainTree.put(newVirus);
    return mass;
}

function removeFood() {
    if (foodArray.length > 0) {
        var f = foodArray.pop();
        mainTree.remove(f, 'id');
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

function computeMaxCellsRadius() {

    function max(acc, cur) {
        return Math.max(acc, cur);
    }

    function maxCellRadius(player) {
        function radius(cell) {
            return cell.radius;
        }
        player.cells.map(radius).reduce(max, util.massToRadius(c.defaultPlayerMass));
    }

    return users.map(maxCellRadius).reduce(max, util.massToRadius(c.defaultPlayerMass));
}

function balanceMass() {

    var keepOutRadius = computeMaxCellsRadius();

    var allocatedTotalMass = foodArray.length * c.foodMass +
        users
            .map(function(u) {return u.massTotal; })
            .reduce(function(pu,cu) { return pu+cu;}, 0) +
        massFood
            .map(function(m) { return m.masa; })
            .reduce(function(pm, cm) { return pm + cm;}, 0) +
        virusArray
            .map(function(v) { return v.mass / 4; })
            .reduce(function(pv, cv) { return pv + cv;}, 0);

    var missingFoodSlots = c.maxFood - foodArray.length;
    var availableFoodSlots = Math.floor((c.gameMass - allocatedTotalMass) / c.foodMass);
    var foodToAdd = Math.min(availableFoodSlots, missingFoodSlots);
    var foodToRemove = Math.max(0, -availableFoodSlots, -missingFoodSlots);

    while (0 < foodToAdd--) {
        addFood(1);
        availableFoodSlots -= c.foodMass;
        if (virusArray.length / c.maxVirus < foodArray.length / c.maxFood &&
                virusArray.length < c.maxVirus && availableFoodSlots >= c.virus.defaultMass.to) {
            availableFoodSlots -= addVirus(keepOutRadius);
        }
    }
    while (0 < foodToRemove--) {
        removeFood();
    }

    var virusToAdd = c.maxVirus - virusArray.length;

    while (0 < virusToAdd-- && availableFoodSlots >= c.virus.defaultMass.to) {
        availableFoodSlots -= addVirus(keepOutRadius);
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
                    uniqId: 'C.' + shortid.generate(),
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
    if (cell.mass >= c.defaultPlayerMass * 4) {
        cell.mass = cell.mass / 2;
        cell.radius = util.massToRadius(cell.mass);
        var newCell = {
            id: currentPlayer.id,
            uniqId: 'C.' + shortid.generate(),
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
    if (currentPlayer.massTotal < c.defaultPlayerMass * 4) {
        return; // can't make two parts of twice the default mass: abort
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
            uniqId: 'C.' + shortid.generate(),
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
                    uniqId: 'C.' + shortid.generate(),
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
            } else if (varValue === "true" || varValue === "false") {
                varValue = varValue === "true" ? true : false;
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

function treatCollisions(currentPlayer) {

    function eatFoodOrVirus(thing) {
        if (!SAT.pointInCircle(thing, cellCircle)) {
            return;
        }
        var type = thing.id.charAt(0),
            idx;
        switch (type) {
            case "F":
                var food = thing;
                foodArray.splice(food.num, 1);
                for (idx = food.num; idx < foodArray.length; idx += 1) {
                    foodArray[idx].num = idx;
                }
                mainTree.remove(food, 'id');
                masaGanada += c.foodMass;
                break;
            case "V":
                var virus = thing;
                if (currentCell.mass <= virus.mass) {
                    break;
                }
                virusArray.splice(virus.num, 1);
                for (idx = virus.num; idx < virusArray.length; idx += 1) {
                    virusArray[idx].num = idx;
                }
                mainTree.remove(virus, 'id');
                virusHits.push({ cell: currentCell, virus: virus });
                masaGanada += virus.mass;
                break;
        }
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

    function collectEatenOtherCells(otherCell) {
        if (otherCell.mass <= 10 || otherCell.id === currentPlayer.id) {
            return true; // continue iterating in the quadtree
        }

        // we check mass first because it's easy to compute
        if (currentCell.mass < (otherCell.mass * 1.1)) {
            return true; // continue iterating in the quadtree
        }

        var collision = new SAT.Response(),
            collided = SAT.testCircleCircle(cellCircle, new C(otherCell, otherCell.radius), collision);
        if (!collided) {
            return true; // continue iterating in the quadtree
        }

        // A cell eats another when less than 30% of the other cell's radius is outside
        if (!collision.bInA && collision.overlap <= otherCell.radius * 1.7) {
            return true; // continue iterating in the quadtree
        }
        // logDebug(2, '[DEBUG] Cell collision info:');
        // logDebug(2, collision);

        eatenOtherCells.push(otherCell);
        return true; // continue iterating in the quadtree
    }

    function eatOtherCell(otherCell) {
        logDebug(1, '[DEBUG] Killing user: ' + otherCell.id);

        var playerIdx = util.findIndex(users, otherCell.id);
        if (playerIdx < 0) {
            console.log("[ERROR] eatOtherCell(): can't find player ID [" + otherCell.id + "] while eating one of her/his cells. Aborting kill.");
            return;
        }
        if (users[playerIdx].cells.length > 1) {
            users[playerIdx].massTotal -= otherCell.mass;
            users[playerIdx].cells.splice(otherCell.num, 1);
            for (var idx = otherCell.num; idx < users[playerIdx].cells.length; idx++) {
                users[playerIdx].cells[idx].num = idx;
            }
            tree.remove(otherCell, 'uniqId');
        } else {
            users.splice(playerIdx, 1);
            io.emit('playerDied', { name: otherCell.name });
            sockets[otherCell.id].emit('RIP');
        }
        currentPlayer.massTotal += otherCell.mass;
        currentCell.mass += otherCell.mass;
    }

    var virusHits = [];
    for(var z=0; z<currentPlayer.cells.length; z++) {
        var currentCell = currentPlayer.cells[z],
            cellCenter = new V().copy(currentCell),
            cellCircle = new C(cellCenter, currentCell.radius);

        var masaGanada = 0,
            cellBoundingBoxSearchArea = cellCircle.boundingBoxAsSearchArea();
        mainTree.get(cellBoundingBoxSearchArea).forEach(eatFoodOrVirus);

        var massEaten = massFood.map(eatMass)
            .reduce(function(a, b, c) {return b ? a.concat(c) : a; }, []);

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

        var eatenOtherCells = [];
        tree.get(cellBoundingBoxSearchArea, collectEatenOtherCells);
        eatenOtherCells.forEach(eatOtherCell);
    }

    function virusHitToExplosion(hit) {
        explodeCell(currentPlayer, hit.cell, hit.virus);
    }
    virusHits.forEach(virusHitToExplosion);
}

function moveloop() {
    var duration = -new Date().getTime();

    tree.clear();
    for (var idx = 0; idx < users.length; idx += 1) {
        if(users[idx].lastHeartbeat < new Date().getTime() - c.maxHeartbeatInterval) {
            sockets[users[idx].id].emit('kick', 'Last heartbeat received over ' + c.maxHeartbeatInterval + 'ms ago.');
            sockets[users[idx].id].disconnect();
        }

        movePlayer(users[idx]);
        users[idx].cells.forEach(tree.put); // we put cells in quadtree after they have moved
    }

    for (var i = 0; i < users.length; i++) {
        treatCollisions(users[i]);
    }
    for (i=0; i < massFood.length; i++) {
        if(massFood[i].speed > 0) moveMass(massFood[i]);
    }

    duration += new Date().getTime();
    profilingAccumulateValue("moveloop", duration);
}

function profilingAccumulateValue(name, value) {
    if (!c.profiling) {
        return;
    }
    profiling[name].serie[0] += value;
}

function padded(chars, val) {
    var str = String(val);
    return Array(Math.max(0, chars - str.length) + 1).join(" ") + str;
}

function printFigure(num) {
    return padded(4, num);
}

function rotateProfiling(name) {
    function sum(accu, curVal) {
        return accu + curVal;
    }
    function sumDistanceToMedianSq(accu, curVal) {
        var dist = curVal - median;
        return accu + dist * dist;
    }

    if (!c.profilingSeries || !c.profiling) {
        return;
    }

    var serie = profiling[name].serie,
        median = Math.round((serie.reduce(sum, 0) / serie.length) * 10) / 10,
        stdDev = Math.round(Math.sqrt(serie.reduce(sumDistanceToMedianSq, 0) / serie.length) * 10) / 10;
    logDebug(1, "[PROFILING] " + padded(11, name) + ": " +
        "med:" + padded(5, median) + ", stdDev:" + padded(5, stdDev) + ", " +
        "[ " + serie.map(printFigure).join(",") + " ]");

    var distrib = profiling[name].distrib,
        roundedVal = Math.round(serie[0]);
    if (!distrib[roundedVal]) {
        distrib[roundedVal] = 1;
    } else {
        distrib[roundedVal] += 1;
    }

    serie.unshift(0);
    if (serie.length > c.profilingSerieMaxLength) {
        serie.pop();
    }
}

function printDistribution(name) {
    if (!c.profilingDistribs || !c.profiling) {
        return;
    }

    var distrib = profiling[name].distrib;
    if (!distrib.count) {
        distrib.count = 1;
    } else {
        distrib.count += 1;
    }
    if (users.length <= 0 || distrib.count < c.profilingDistribCollectSec) {
        return;
    }

    var idx;
    for (idx = 0; idx < distrib.length; idx += 1) {
        if (!distrib[idx]) {
            distrib[idx] = 0;
        }
        // logDebug(3, "[TRACE] printDistribution(): idx=" + idx + ", distrib[idx]=" + distrib[idx] + ", ");
    }
    var ninethDecile = distrib.length - 1,
        accu = 0;
    while (ninethDecile >= 0 && accu + distrib[ninethDecile] < distrib.count / 10) {
        // logDebug(3, "[TRACE] printDistribution(): accu=" + accu + ", ninethDecile=" + ninethDecile + ", distrib[ninethDecile]=" + distrib[ninethDecile] + ", ");
        accu += distrib[ninethDecile];
        ninethDecile -= 1;
    }
    // NOTE: distrib.join() often doesn't join all array elements, ignoring a
    // large part of them, and we didn't find the reason why. Thus we revert
    // to a plain old manual join instead.
    var distribAsTabSeparatedValues = "";
    if (distrib.length > 0) {
        distribAsTabSeparatedValues += String(distrib[0]);
    }
    for (idx = 1; idx < distrib.length; idx += 1) {
        distribAsTabSeparatedValues += "\t" + distrib[idx];
    }
    logDebug(1, "[PROFILING] " + padded(11, name) + ": " +
        "count=" + distrib.count + ", ninethDecile=" + ninethDecile + ", length=" + distrib.length + ", " +
        "[" + distribAsTabSeparatedValues + "]");

    profiling[name].distrib = [];
    profiling[name].distrib.count = 0;
}

function gameloop() {
    var duration = -new Date().getTime();

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

    duration += new Date().getTime();
    profilingAccumulateValue("gameloop", duration);

    rotateProfiling("gameloop");
    rotateProfiling("moveloop");
    rotateProfiling("sendUpdates");

    printDistribution("gameloop");
    printDistribution("moveloop");
    printDistribution("sendUpdates");
}

function sendUpdates() {

    function minifyNum(num) {
        return Math.round(num * 10) / 10;
    }

    function minifyCellOrVirus(thing) {
        return {
            x: minifyNum(thing.x),
            y: minifyNum(thing.y),
            radius: minifyNum(thing.radius),
            mass: Math.round(thing.mass)
        };
    }

    function sendUpdatesForUser(u) {

        function collectVisibleFood(thing) {
            if (thing.id.charAt(0) === 'F') {
                visibleFood.push({
                    x: minifyNum(thing.x),
                    y: minifyNum(thing.y),
                    radius: minifyNum(thing.radius),
                    hue: thing.hue
                });
            }
            return true; // continue iterating the quadtree
        }

        function collectVisibleVirus(thing) {
            if (thing.id.charAt(0) === 'V') {
                visibleViruses.push(minifyCellOrVirus(thing));
            }
            return true; // continue iterating the quadtree
        }

        function collectVisiblePlayerCell(cell) {
            // TODO: refine visibility, based on cell's own radius
            if (cell.x + cell.radius > viewArea.x - 20 &&
                    cell.x - cell.radius < viewArea.x + viewArea.w + 20 &&
                    cell.y + cell.radius > viewArea.y - 20 &&
                    cell.y - cell.radius < viewArea.y + viewArea.h + 20) {
                var player = preRenderedPlayers[cell.id];
                if (!player) { // player might have died since last quadtree construction
                    return true;
                }
                player.cells.push(player.preRenderedCells[cell.num]);
                visiblePlayersById[cell.id] = player;
            }
            return true; // continue iterating the quadtree
        }

        function renderPlayer(player) {
            var renderedPlayer;
            if (player.id === u.id) {
                renderedPlayer = {
                    x: player.x,
                    y: player.y,
                    cells: player.cells,
                    hue: player.hue,
                    viewWidth: viewWidth,
                    viewHeight: viewHeight
                };
            } else {
                renderedPlayer = {
                    id: player.id,
                    x: player.x,
                    y: player.y,
                    cells: player.cells,
                    hue: player.hue,
                    name: player.name
                };
                if (c.debugLevel >= 2) {
                    var largestDimension = Math.max(player.screenWidth, player.screenHeight);
                    renderedPlayer.viewWidth = Math.round(player.screenWidth * player.viewZoom / largestDimension);
                    renderedPlayer.viewHeight = Math.round(player.screenHeight * player.viewZoom / largestDimension);
                }
            }
            visiblePlayers.push(renderedPlayer);
        }

        var largestDimension = Math.max(u.screenWidth, u.screenHeight),
            viewWidth = Math.round(u.screenWidth * u.viewZoom / largestDimension),
            viewHeight = Math.round(u.screenHeight * u.viewZoom / largestDimension),
            viewArea = {
                x: u.x - viewWidth/2,
                y: u.y - viewHeight/2,
                w: viewWidth,
                h: viewHeight
            };

        var visibleFood = [];
        mainTree.get(viewArea, util.massToRadius(c.foodMass), collectVisibleFood);

        var visibleViruses = [];
        mainTree.get(viewArea, util.massToRadius(c.virus.splitMass), collectVisibleVirus);

        var visibleMass = massFood
            .map(function(f) {
                if ( f.x+f.radius > u.x - viewWidth/2 - 20 &&
                    f.x-f.radius < u.x + viewWidth/2 + 20 &&
                    f.y+f.radius > u.y - viewHeight/2 - 20 &&
                    f.y-f.radius < u.y + viewHeight/2 + 20) {
                    return {
                        x: minifyNum(f.x),
                        y: minifyNum(f.y),
                        radius: minifyNum(f.radius),
                        mass: Math.round(f.mass),
                        hue: f.hue
                    };
                }
            })
            .filter(function(f) { return f; });


        var visiblePlayersById = {};
        tree.get(viewArea, maxCellsRadius, collectVisiblePlayerCell);

        var visiblePlayers = [];
        for (var id in visiblePlayersById) {
            if (visiblePlayersById.hasOwnProperty(id)) {
                renderPlayer(visiblePlayersById[id]);
            }
        }

        if (visiblePlayers.length <= 0 && u.type !== "spectate") {
            console.log("[ERROR] sendUpdates(): the visiblePlayers array is empty for user [" + u.name + "]");
        }

        sockets[u.id].emit('serverTellPlayerMove', visiblePlayers, visibleFood, visibleMass, visibleViruses);
        if (leaderboardChanged) {
            sockets[u.id].emit('leaderboard', {
                players: users.length,
                leaderboard: leaderboard
            });
        }
    }

    function precalcPlayer(player) {
        preRenderedPlayers[player.id] = {
            id: player.id,
            x: minifyNum(player.x),
            y: minifyNum(player.y),
            cells: [],
            preRenderedCells: player.cells.map(minifyCellOrVirus),
            hue: player.hue,
            name: player.name,
            screenWidth: player.screenWidth,
            screenHeight: player.screenHeight,
            viewZoom: player.viewZoom
        };
    }

    var duration = -new Date().getTime();

    var preRenderedPlayers = {};
    users.forEach(precalcPlayer);
    var maxCellsRadius = computeMaxCellsRadius();

    users.forEach(sendUpdatesForUser);
    leaderboardChanged = false;

    duration += new Date().getTime();
    profilingAccumulateValue("sendUpdates", duration);
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
