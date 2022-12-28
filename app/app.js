var express = require('express'); // Express web server framework
var request = require('request'); // "Request" library
var cors = require('cors');
var querystring = require('querystring');
var cookieParser = require('cookie-parser');
const yaml = require('js-yaml');
const fs = require('fs');
const XMLHttpRequest = require('xmlhttprequest').XMLHttpRequest;


function readConfigFile(filename) {
  try {
    const doc = yaml.load(fs.readFileSync(filename, 'utf8'));
    return doc;
  } catch (e) {
    console.log(e);
  }
}


const config = readConfigFile("./config.yml");

var client_id = config.client_id; // Your client id
var client_secret = config.client_secret; // Your secret
var redirect_uri = config.redirect_uri; // Your redirect uri
var generatedPlaylistName = config.generated_playlist_name; // Your redirect uri

/**
 * Generates a random string containing numbers and letters
 * @param  {number} length The length of the string
 * @return {string} The generated string
 */
var generateRandomString = function (length) {
  var text = '';
  var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (var i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

var stateKey = 'spotify_auth_state';

var app = express();

app.use(express.static(__dirname + '/public'))
  .use(cors())
  .use(cookieParser());

app.get('/login', function (req, res) {

  var state = generateRandomString(16);
  res.cookie(stateKey, state);

  // your application requests authorization
  var scope = 'user-read-private user-read-email user-library-read playlist-read-private playlist-modify-public playlist-modify-private';
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    }));
});

var DEFAULT_LIMIT_MAX = 50;
var DEFAULT_PLAYLIST_LIMIT_MAX = 100;
var DEFAULT_SAVED_SONGS_LIMIT_MAX = 50;

var access_token_global = '';
app.get('/callback', async function (req, res) {

  // your application requests refresh and access tokens
  // after checking the state parameter

  var code = req.query.code || null;
  var state = req.query.state || null;
  var storedState = req.cookies ? req.cookies[stateKey] : null;

  if (state === null || state !== storedState) {
    res.redirect('/#' +
      querystring.stringify({
        error: 'state_mismatch'
      }));
  } else {
    res.clearCookie(stateKey);
    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      },
      headers: {
        'Authorization': 'Basic ' + (new Buffer.alloc((client_id + ':' + client_secret).length, client_id + ':' + client_secret).toString('base64'))
      },
      json: true
    };

    request.post(authOptions, function (error, response, body) {
      if (!error && response.statusCode === 200) {

        var access_token = body.access_token,
          refresh_token = body.refresh_token;
        access_token_global = access_token;


        var options = {
          url: 'https://api.spotify.com/v1/me',
          headers: { 'Authorization': 'Bearer ' + access_token },
          json: true
        };

        // use the access token to access the Spotify Web API
        request.get(options, function (error, response, body) {
          console.log(body);
        });


        mainScript();

        // we can also pass the token to the browser to make requests from there
        res.redirect('/#' +
          querystring.stringify({
            access_token: access_token,
            refresh_token: refresh_token
          }));
      } else {
        res.redirect('/#' +
          querystring.stringify({
            error: 'invalid_token'
          }));
      }
    });
  }
});

function sortByProperty(property) {
  return function (a, b) {
    if (a[property] > b[property])
      return 1;
    else if (a[property] < b[property])
      return -1;

    return 0;
  }
}

Array.prototype.diff = function (a) {
  return this.filter(function (i) { return a.indexOf(i) < 0; });
};

async function mainScript() {
  const TrackLikedHistoryGeneratedPlaylistId = await searchPlaylist(generatedPlaylistName || 'TrackLikedHistoryGenerated');

  let playlistSongs = await getPlaylistsSongs(TrackLikedHistoryGeneratedPlaylistId);

  const savedSongs = await getSavedSongs();

  const currentDate = new Date(Date.now());

  await exportCsvBackup(Object.keys(savedSongs[0]), savedSongs, ',', __dirname + '/csvBackup/SavedSongs_' + currentDate.getFullYear() + '_' + (currentDate.getMonth() + 1).toString() + '_' + currentDate.getDate().toString() + '.csv');

  const playlistSongsSorted = playlistSongs.sort(sortByProperty('name')).map(item => ({ addedDate: item.addedDate, json: JSON.stringify({ name: item.name, artist: item.artist, uri: item.uri, id: item.id }) }));
  const savedSongsSorted = savedSongs.sort(sortByProperty('name')).map(item => ({ addedDate: item.addedDate, json: JSON.stringify({ name: item.name, artist: item.artist, uri: item.uri, id: item.id }) }));
  const diffOfLikedSongs = savedSongsSorted.filter(x => !(playlistSongsSorted.map(x => x.json)).includes(x.json));

  const diffOfLikedSongsSortedByDate = diffOfLikedSongs.sort(sortByProperty('addedDate'));
  
  if (diffOfLikedSongs.length > 0) await addSongsToPlaylist(TrackLikedHistoryGeneratedPlaylistId, diffOfLikedSongsSortedByDate.map(x => JSON.parse(x.json)), null);


  console.log('playlist backuped')
}

app.get('/refresh_token', function (req, res) {

  // requesting access token from refresh token
  var refresh_token = req.query.refresh_token;
  var authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    headers: { 'Authorization': 'Basic ' + (new Buffer.alloc((client_id + ':' + client_secret).length, client_id + ':' + client_secret).toString('base64')) },
    form: {
      grant_type: 'refresh_token',
      refresh_token: refresh_token
    },
    json: true
  };

  console.log('authOptions : ', authOptions);

  request.post(authOptions, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      var access_token = body.access_token;
      console.log('access_token : ', access_token);

      res.send({
        'access_token': access_token
      });
    }
  });


});

function requestHTML(method, url, body) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.setRequestHeader('Authorization', 'Bearer ' + access_token_global);
    xhr.cook
    xhr.responseType = 'json';
    xhr.onload = function () {
      var status = xhr.status;
      if (status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject({ status, message: xhr.responseText });
      }
    };
    xhr.send(JSON.stringify(body));
  }).catch((error) => {
    throw Error(error);
  });
}

async function searchPlaylist(playlistName) {

  numberOfPlaylist = await requestHTML('GET', 'https://api.spotify.com/v1/me/playlists?limit=0&offset=0');


  for (i = 0; i < numberOfPlaylist.total; i = i + DEFAULT_LIMIT_MAX) {
    const result = await requestHTML('GET', 'https://api.spotify.com/v1/me/playlists?limit=' + DEFAULT_LIMIT_MAX.toString() + '&offset=' + i.toString())
    for (item in result.items) {
      if (result.items[item].name === playlistName) {
        return result.items[item].id
      }
    }
  }

  return createPlaylist(playlistName);


}


async function getPlaylistsSongs(playlistId) {

  const numberOfTracks = await requestHTML('GET', 'https://api.spotify.com/v1/playlists/' + playlistId + '/tracks?market=FR&fields=total&limit=' + DEFAULT_PLAYLIST_LIMIT_MAX.toString() + '&offset=0');
  let itemOld;
  const playlistSongsArray = []
  for (i = 0; i < numberOfTracks.total; i = i + DEFAULT_PLAYLIST_LIMIT_MAX) {
    const result = await requestHTML('GET', 'https://api.spotify.com/v1/playlists/' + playlistId + '/tracks?market=FR&fields=items(added_at,track(name%2Curi%2Cid%2Cartists(name)))&limit=' + DEFAULT_PLAYLIST_LIMIT_MAX.toString() + '&offset=' + i.toString())
    for (j = 0; j < result.items.length; j++) {
      try {
        playlistSongsArray.push({
          addedDate: result.items[j].added_at,
          name: result.items[j].track.name,
          artist: result.items[j].track.artists[0].name,
          id: result.items[j].track.id,
          uri: result.items[j].track.uri
        });
      } catch (ex) {
        console.log('getPlaylistSongs : ' + ex.message + ' : \n  item number : ' + j + '\n    ' + JSON.stringify(result.items[j]));
      }
    }
  }

  return playlistSongsArray;
}

async function getSavedSongs(backupSongsArray) {

  const numberOfTracks = await requestHTML('GET', 'https://api.spotify.com/v1/me/tracks?market=FR&limit=' + DEFAULT_SAVED_SONGS_LIMIT_MAX.toString() + '&offset=0');

  const savedSongsArray = []
  for (i = 0; i < numberOfTracks.total; i = i + DEFAULT_SAVED_SONGS_LIMIT_MAX) {
    const result = await requestHTML('GET', 'https://api.spotify.com/v1/me/tracks?market=FR&limit=' + DEFAULT_SAVED_SONGS_LIMIT_MAX.toString() + '&offset=' + i.toString())
    for (j = 0; j < result.items.length; j++) {
      try {

        if (result.items[j].track.name === backupSongsArray && backupSongsArray[0]) {
          return savedSongsArray;
        }
        else {
          savedSongsArray.push({
            addedDate: result.items[j].added_at,
            name: result.items[j].track.name,
            artist: result.items[j].track.artists[0].name,
            id: result.items[j].track.id,
            uri: result.items[j].track.uri
          }
          );
        }
      } catch (ex) {
        console.log('getSavedSongs' + ex.message + ' : \n  item number : ' + j + '\n    ' + JSON.stringify(result.items[j]));
      }
    }
  }

  return savedSongsArray;
}

async function createPlaylist(playlistName) {

  const body = {
    "name": playlistName,
    "description": "Song playlist storing song liked",
    "public": false
  }

  const { id } = await requestHTML('POST', 'https://api.spotify.com/v1/me/playlists', body);
  return id;
}

function getCsvBackup(fileName) {

  try {
    if (fs.existsSync(fileName)) {
      const data = fs.readFileSync(fileName);
      return data;
    }
  } catch (err) {
    return null;
  }


}

async function exportCsvBackup(arrayHeader, arrayData, delimiter, fileName) {
  let header = arrayHeader.join(delimiter) + '\n';
  await fs.access(fileName, (err) => {
    if (err) {
      fs.writeFileSync(fileName, header, 'utf-8');
    }
  });
  let data = arrayData.map(x => Object.values(x).join(delimiter));
  await fs.writeFileSync(fileName, data.join('\n'), 'utf-8');

}


async function addSongsToPlaylist(playlistId, savedSongsArray, fileName) {

  for (i = 0; i < savedSongsArray.length;i++) {
    try {
      await requestHTML('POST', 'https://api.spotify.com/v1/playlists/' + playlistId + '/tracks?uris=' + savedSongsArray[i].uri);
      console.log('song backuped: ' + savedSongsArray[i].name + '   artist: ' + savedSongsArray[i].artist);
    } catch (ex) {
      console.log(ex.message);
    }
  }

}



console.log('Listening on 8888');
app.listen(8888);

