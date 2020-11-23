"use strict";

const qs = require('querystring');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const TIE = require('@artificialsolutions/tie-api-client');
const dotenv = require('dotenv');
dotenv.config();
const {
    TENEO_ENGINE_URL,
    LANGUAGE_STT,
    LANGUAGE_TTS,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_OUTBOUND_NUMBER,
    START_MESSAGE
} = process.env;

const postPath = {
    default: '/'
};

const teneoApi = TIE.init(TENEO_ENGINE_URL);
var twilioLanguage = LANGUAGE_STT || 'en-US'; // See: https://www.twilio.com/docs/voice/twiml/gather#languagetags
const twilioVoiceName = LANGUAGE_TTS || 'Polly.Joanna'; // See: https://www.twilio.com/docs/voice/twiml/say/text-speech#amazon-polly

let twilioActions = {
    gather_default: '/gather_default',
    record_default: '/record_default',
    outbound_call: '/outbound_call',
    hang_up: '/hang_up'
};
let twilioAction = postPath.default;

/**
 * Variables used to keep track of current state.
 */
var teneoResponse = null;
var teneoSessionId = "";
var confidence = "";
var phone = "";

// Initiates the biometric authentication solution
var userInput = START_MESSAGE;

console.log("LANGUAGE_STT: " + LANGUAGE_STT);
console.log("LANGUAGE_TTS: " + LANGUAGE_TTS);
console.log("TENEO_ENGINE_URL: " + TENEO_ENGINE_URL);

class twilio_voice {

    static generateJSONObjectFromGroovyMap(givenMapObject) {

        var original_list = [":", ",","[","]"];
        var replaced_list = ['":"', '","','{"','"}'];

        var json_string_list = givenMapObject.split(",");

        original_list.forEach((original, index) => {
            var original_value = original;
            var replaced_value = replaced_list[index];
            for(var i = 0; i < json_string_list.length; i++) {
                json_string_list[i] = json_string_list[i].replace(original_value, replaced_value);
            }
        });

        var json_string_output = "";

        for(var i = 0; i < json_string_list.length; i++) {
            if(json_string_list[i].charAt(0) === " ") {
                json_string_list[i] = json_string_list[i].substring(1);
            }
            json_string_output += json_string_list[i].replace("<[^>]*>", "");
            if(i < (json_string_list.length-1)) {
                json_string_output += '","'
            }
        }

        return json_string_output;
    }

    static convertGroovyMapToTeneoOutput(givenMapObject) {

            // Filing a claim
            if(givenMapObject.includes("||")) {
                givenMapObject = givenMapObject.split("||")[0];

                var response_output = JSON.parse(twilio_voice.generateJSONObjectFromGroovyMap(givenMapObject));

                var content_title = "Title: " + response_output["claimTitle"] + ", ";
                var content_description = "Description: " + response_output["claimDescriptionContent"] + ", ";
                var content_details = response_output["claimDetailsContent"].replace(/<\/?[^>]+(>|$)/g, "").replace("Date", ", Date");

                var teneo_response = "I have summarized your claim as follows:\n" + content_title + content_description + content_details + ". Is this correct?";
            }
            else if(givenMapObject.includes("[[")) {
                // [[date:2020-11-12, desc:My car broke down, amount:200]]
                givenMapObject = givenMapObject.replace("[[","[").replace("]]","]");

                var response_output = twilio_voice.generateJSONObjectFromGroovyMap(givenMapObject);

                if(response_output.includes('}","{')) {
                    response_output = "[" + response_output.replace('}","{','},{') + "]";
                }

                response_output = JSON.parse(response_output);

                var entries = "";

                if(Array.isArray(response_output)) {
                    entries = "These are the details of your claims: \n";
                    for(var i = 0; i < response_output.length; i++) {
                        var content_title = " Date: " + response_output[i]["date"] + ", ";
                        var content_description = "Description: " + response_output[i]["desc"] + ", ";
                        var content_details = "Claim amount: " + response_output[i]["amount"] + " EUR";
                        entries += " Claim #" + String(i+1) + content_title + content_description + content_details + " \n";
                    }
                } else {
                    var content_title = " Date: " + response_output["date"] + ", ";
                    var content_description = "Description: " + response_output["desc"] + ", ";
                    var content_details = "Claim amount: " + response_output["amount"] + " EUR";
                    entries = "These are the details for your claim: " + content_title + content_description + content_details;
                }

                teneo_response = entries;
            }

            return teneo_response;
    }

    // handle incoming twilio message
    handleInboundCalls() {

        // initialise session handler, to store mapping between twillio CallSid and engine session id


        return async (req, res) => {

            let body = '';

            req.on('data', function (data) {
                body += data;
            });

            req.on('end', async function () {
                // parse the body
                var post = qs.parse(body);

                if(phone === "") {
                    if("phone" in req.query) {
                        phone = "+" + req.query["phone"].replace(/[^0-9]/g, '');
                    }
                    else {
                        phone = post.Caller;
                    }
                }

                // get the caller id
                const callSid = post.CallSid;

                // check if we have stored an engine sessionid for this caller
                teneoSessionId = sessionHandler.getSession(callSid);

                // Detect if userinput exists
                if (post.CallStatus === 'in-progress' && post.SpeechResult) {
                    userInput = post.SpeechResult;
                    console.log("User said: " + userInput);
                    // Capture confidence score
                    if (post.Confidence) {
                        confidence = post.Confidence;
                    }
                }

                var parameters = {};

                // Detect digit input from the user, add additional if statement to capture timeout
                if(post.Digits !== "timeout" && post.Digits) {
                    parameters["keypress"] = post.Digits;
                }

                // Detect if recording exists from input
                if(post.RecordingSid) {
                    parameters["url"] = post.RecordingUrl;
                }

                parameters["phone"] = phone;

                var contentToTeneo = {'text': userInput, "parameters": JSON.stringify(parameters), "channel":"ivr"};

                console.log("Content to Teneo: " + JSON.stringify(contentToTeneo).toString());

                // Add "_phone" to as key to session to make each session, regardless when using call/sms
                teneoResponse = await teneoApi.sendInput(teneoSessionId, contentToTeneo);

                sessionHandler.setSession(callSid, teneoResponse.sessionId);

                // Detect if Teneo solution have provided a Twilio action as output parameter
                if(Object.keys(teneoResponse.output.parameters).length !== 0) {
                    if(Object.keys(teneoResponse.output.parameters).includes("twilioAction")) {
                        twilioAction = teneoResponse.output.parameters["twilioAction"];
                    }
                    if(Object.keys(teneoResponse.output.parameters).includes("twilioLanguage")) {
                        twilioLanguage = teneoResponse.output.parameters["twilioLanguage"];
                    }
                    // Swap SMS text with default output text to be read out
                    if(Object.keys(teneoResponse.output.parameters).includes("sms")) {
                        teneoResponse.output.text = twilio_voice.convertGroovyMapToTeneoOutput(teneoResponse.output.parameters["sms"]);
                    }
                }

                console.log("Output response: " + teneoResponse.output.text);

                if(twilioAction === postPath.default) {
                    twilioAction = twilioActions.gather_default;
                }

                switch (twilioAction) {

                    // Twilio action to handle voice inputs by end-user, speaking to the end user and then capturing the voice subsequently.
                    case twilioActions.gather_default:
                        var twiml = new VoiceResponse();
                        twiml.gather({
                            input: 'speech dtmf',
                            action: postPath.default,
                            actionOnEmptyResult: false,
                            language: twilioLanguage,
                            timeout: 20,
                            speechTimeout: "auto"
                        }).say({
                            voice: twilioVoiceName,
                            language: twilioLanguage
                        }, teneoResponse.output.text);
                        res.writeHead(200, {'Content-Type': 'text/xml'});
                        res.end(twiml.toString());
                        break;

                    // Twilio action to handle voice recording by end-user, starts with a beep and records the audio to a audio file.
                    case twilioActions.record_default:
                        var twiml = new VoiceResponse();
                        twiml.say({
                            voice: twilioVoiceName,
                            language: twilioLanguage
                        }, teneoResponse.output.text);
                        twiml.record({
                            action: postPath.default,
                            maxLength: 5,
                            trim: 'do-not-trim'
                        });
                        res.writeHead(200, {'Content-Type': 'text/xml'});
                        res.end(twiml.toString());
                        break;

                    case twilioActions.hang_up:
                        var twiml = new VoiceResponse();
                        twiml.say({
                            voice: twilioVoiceName,
                            language: twilioLanguage
                        }, teneoResponse.output.text);
                        twiml.hangup();
                        res.writeHead(200, {'Content-Type': 'text/xml'});
                        res.end(twiml.toString());
                        break;
                }
            });
        }
    }

    handleOutboundCalls() {

        return async (req, res) => {

            userInput = "";

            const client = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

            /*phone = "+" + req.url.replace("/outbound_call", "").replace(/[^0-9]/g, '');

            if(req.url.includes("twilioLanguage")) {
                twilioLanguage = req.url.split("&twilioLanguage=")[1]
            }*/

            console.log(req.url);

            var parameters = req.url.split("?")[1].split("&");

            var parameters_map = {};

            for(var i = 0; i < parameters.length; i++) {
                var entry = parameters[i].split("=");
                parameters_map[entry[0]] = entry[1];
            }

            if(req.url.includes("phone")) {
                phone = parameters_map["phone"];
            } else if (req.url.includes("twilioLanguage")) {
                twilioLanguage = parameters_map["twilioLanguage"];
            } else if (req.url.includes("sessionid")) {
                sessionHandler.setSession(phone, parameters_map["sessionid"])
            }


            const url = "http://" + req.headers["host"] + "/";

            client.calls
                .create({
                    twiml: '<Response><Redirect method="POST">' + url + '</Redirect></Response>',
                    to: phone,
                    from: TWILIO_OUTBOUND_NUMBER
                })
                .then(call =>
                    console.log(JSON.stringify(call))
                );

                res.writeHead(200, {'Content-Type': 'text/xml'});
                res.end();
        }
    }

    // handle incoming twilio message
    handleCallChange() {

        return async (req, res) => {

            let body = '';

            req.on('data', function (data) {
                body += data;
            });

            req.on('end', async function () {
                // parse the body
                var post = qs.parse(body);

                //console.log(post);

                if(post.CallStatus === "completed") {
                    var token = '73bbe8ba-72fd-4f8b-913c-dee978c43519';
                    var appName = 'standard-insurance-app';
                    var Heroku = require('heroku-client');

                    var heroku = new Heroku({ token: token });
                    heroku .delete('/apps/' + appName + '/dynos/')
                        .then( x => console.log("Call completed, restarting server now") );
                }
            });
        }
    }

    /***
     * SESSION HANDLER
     ***/
    SessionHandler() {

        const sessionMap = new Map();

        return {
            getSession: (userId) => {
                if (sessionMap.size > 0) {
                    return sessionMap.get(userId);
                }
                else {
                    return "";
                }
            },
            setSession: (userId, sessionId) => {
                sessionMap.set(userId, sessionId)
            }
        };
    }
}

module.exports = twilio_voice;