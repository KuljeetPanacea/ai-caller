import asyncio
import json
import os
import sys
import traceback
from google import genai
from google.genai import types
import pyaudio
from tabulate import tabulate

# Fix Windows console encoding for emoji/unicode output
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 1. Define your 8 Predefined Questions
PREDEFINED_QUESTIONS = [
    "What is your main health problem today?",
    "Since when are you facing this problem?",
    "How severe is your problem right now?",
    "How has the problem changed over time?",
    "Have you taken any treatment or medicine for this problem?",
    "Do you experience heavy bleeding during periods?",
    "Do you feel shortness of breath while walking or climbing stairs?",
    "Do you have any existing medical condition?"
]

# Audio Configuration
FORMAT = pyaudio.paInt16
CHANNELS = 1
INPUT_RATE = 16000   # Gemini Live prefers 16kHz for input
OUTPUT_RATE = 24000  # Gemini Live outputs 24kHz natively
CHUNK_SIZE = 1024

class VoiceInterviewManager:
    def __init__(self, on_transcript=None, on_complete=None):
        self.client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
        self.model = "gemini-3.1-flash-live-preview"
        self.p = pyaudio.PyAudio()
        self.on_transcript = on_transcript
        self.on_complete = on_complete
        
        # State tracking
        self.current_question_idx = 0
        # self.token_log = []
        self.full_transcript = []
        self.overarching_summary = ""
        self.summary_text = ""
        # Tracks in-progress transcription before final emission
        self._pending_input_text = ""
        self._pending_model_turn_text = ""
        # End-state tracking
        self.all_questions_answered = False
        self.awaiting_final_goodbye = False
        # Event to control microphone streaming
        self.audio_stream_event = asyncio.Event()
        self.audio_stream_event.set()  # initially allow streaming
        self.model_was_speaking = False

    async def _emit_transcript(self, role, text):
        if self.on_transcript and text:
            try:
                await self.on_transcript(role, text)
            except Exception:
                print(f"⚠️ Failed to emit transcript line for {role}")

    async def _emit_complete(self):
        if self.on_complete:
            try:
                result = self.on_complete()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                print("⚠️ Failed to emit completion event")

    # submit_answer function definition. this will be called  immediately after the user answers a question
    def get_tools(self):
        """Define a tool to intercept and log answers sequentially."""
        return [
            types.Tool(
                function_declarations=[
                    types.FunctionDeclaration(
                        name="submit_answer",
                        # instruction to the model
                        description="MUST BE CALLED IMMEDIATELY after the user answers a question. Used to record their answer summary.",
                        parameters={
                            "type": "OBJECT",
                            "properties": {
                                "question_number": {"type": "INTEGER", "description": "The 1-based index of the question just answered."},
                                "user_answer_summary": {"type": "STRING", "description": "A clear, comprehensive text summary of the user's vocal response."}
                            },
                            "required": ["question_number", "user_answer_summary"]
                        }
                    )
                ]
            )
        ]

    # This function is responsible for continuously capturing audio from the microphone and streaming it to the Gemini Live session in real time.
    async def mic_stream_task(self, session):
        """Captures microphone audio and streams it to the Gemini Live session."""
        input_stream = self.p.open(
            format=FORMAT,
            channels=1,
            rate=16000,
            input=True,
            input_device_index=1,
            frames_per_buffer=1024
        )
        print("\n🎤 Microphone active. Start speaking when prompted...")
        try:
            while self.current_question_idx < len(PREDEFINED_QUESTIONS):
                # Read raw PCM chunks from microphone and send small chunks to GEMINI
                # Wait until allowed to stream audio
                await self.audio_stream_event.wait()
                data = input_stream.read(CHUNK_SIZE, exception_on_overflow=False)
                await session.send_realtime_input(
                    audio=types.Blob(data=data, mime_type=f"audio/pcm;rate={INPUT_RATE}")
                )
                await asyncio.sleep(0.001)
        except (asyncio.CancelledError, OSError) as e:
            if isinstance(e, OSError):
                print("\n🎤 Microphone stream closed.")
        finally:
            try:
                if input_stream.is_active():
                    input_stream.stop_stream()
                input_stream.close()
            except OSError:
                pass  # Stream may already be closed

    async def run_interview(self):
        # Configure instructions to strictly respect the sequence
        questions_text = "\n".join(f"{i+1}. {q}" for i, q in enumerate(PREDEFINED_QUESTIONS))
        system_instruction = (
            "You are an automated voice interviewer conducting a health assessment. "
            "You must ask the user the following questions ONE BY ONE in exactly this order:\n\n"
            f"{questions_text}\n\n"
            "STRICT GUIDELINES:\n"
            "1. Speak the first question clearly in audio. Then STOP and WAIT for the user to answer.\n"
            "2. Listen to the user's vocal response completely.\n"
            "3. AS SOON AS the user finishes answering the current question, you MUST immediately call the `submit_answer` tool to save their response. Do not ask the next question yet!\n"
            "4. You must wait for the function response confirming the answer was saved.\n"
            "5. After receiving the function response, proceed to ask the next question on the list.\n"
            "6. Once all questions have been asked and answered, thank the user and say goodbye."
        )

        config = types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            system_instruction=types.Content(parts=[types.Part(text=system_instruction)]),
            tools=self.get_tools(),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    disabled=False,
                    silence_duration_ms=2000,
                    end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW
                )
            )
        )

        output_stream = self.p.open(
            format=FORMAT, channels=CHANNELS, rate=OUTPUT_RATE, output=True
        )

        # Cumulative trackers
        cumulative_prompt_text = 0
        cumulative_prompt_audio = 0
        cumulative_response_text = 0
        cumulative_response_audio = 0

        # Current turn values
        self._current_turn_p_text = 0
        self._current_turn_p_audio = 0
        self._current_turn_r_text = 0
        self._current_turn_r_audio = 0

        print("🔄 Connecting to Gemini Live API...")
        try:
          async with self.client.aio.live.connect(model=self.model, config=config) as session:
            print("✅ Session connected successfully!")
            
            # Fire up the parallel background microphone capture task FIRST
            mic_task = asyncio.create_task(self.mic_stream_task(session))

            # Trigger the first question explicitly via text
            first_prompt = f"Please ask the first question directly: '{PREDEFINED_QUESTIONS[0]}'"
            print(f"📤 Sending first prompt: {first_prompt}")
            await session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part(text=first_prompt)]),
                turn_complete=True
            )
            print("📤 First prompt sent. Waiting for responses...")

            interview_done = False
            response_count = 0

            # session.receive() yields responses for one turn, so we loop
            while not interview_done:
              async for response in session.receive():
                # If the response has neither content nor tool calls, skip it to avoid errors
                if not response.server_content and not response.tool_call:
                    continue                
                response_count += 1
                
                # Check for usage metadata to track tokens
                usage = getattr(response, "usage_metadata", None)

                if usage:
                    p_tokens = getattr(usage, "prompt_token_count", 0) or getattr(usage, "promptTokenCount", 0)
                    r_tokens = getattr(usage, "response_token_count", 0) or getattr(usage, "responseTokenCount", 0)
                    t_tokens = getattr(usage, "total_token_count", 0) or getattr(usage, "totalTokenCount", 0)
                    
                    if t_tokens > 0: 
                        def parse_modality(details):
                            txt = 0
                            aud = 0
                            if details:
                                for d in details:
                                    modality = getattr(d, "modality", "").upper()
                                    count = getattr(d, "token_count", 0) or getattr(d, "tokenCount", 0)
                                    if "TEXT" in modality:
                                        txt += count
                                    elif "AUDIO" in modality:
                                        aud += count
                            return txt, aud
                            
                        p_details = getattr(usage, "prompt_tokens_details", None) or getattr(usage, "promptTokensDetails", None)
                        r_details = getattr(usage, "response_tokens_details", None) or getattr(usage, "responseTokensDetails", None)

                        print("p_details = ", p_details)
                        print("r_details = ", r_details)
                        print("t_tokens = ", t_tokens)
                        
                        if p_details is not None:
                            self._current_turn_p_text, self._current_turn_p_audio = parse_modality(p_details)
                            cumulative_prompt_text = self._current_turn_p_text
                            cumulative_prompt_audio = self._current_turn_p_audio

                        if r_details is not None:
                            self._current_turn_r_text, self._current_turn_r_audio = parse_modality(r_details)
                # Debug: log what type of response we got

                has_server_content = response.server_content is not None
                has_tool_call = response.tool_call is not None
                has_model_turn = has_server_content and response.server_content.model_turn is not None
                is_turn_complete = has_server_content and response.server_content.turn_complete
                
                # Process voice/audio coming back from Gemini
                if response.server_content and response.server_content.model_turn:
                    # Pause microphone streaming while the model is sending voice/speaking
                    if self.audio_stream_event.is_set():
                        self.audio_stream_event.clear()
                    self.model_was_speaking = True
                    for part in response.server_content.model_turn.parts:
                        if part.inline_data:
                            # Play Gemini's vocal response out of your computer speakers
                            output_stream.write(part.inline_data.data)
                        if getattr(part, "text", None):
                            self._pending_model_turn_text += part.text or ""
                    if self.all_questions_answered:
                        self.awaiting_final_goodbye = True

                if response.server_content:
                    in_t = getattr(response.server_content, "input_transcription", None)
                    if in_t and getattr(in_t, "text", None):
                        self._pending_input_text = in_t.text
                        if getattr(in_t, "finished", False):
                            await self._emit_transcript("user", self._pending_input_text)
                            self._pending_input_text = ""

                # Resume mic stream only when the model's turn is fully complete (has finished speaking)
                if response.server_content and response.server_content.turn_complete:
                    if self._pending_model_turn_text:
                        await self._emit_transcript("ai", self._pending_model_turn_text)
                        self._pending_model_turn_text = ""
                    if self._pending_input_text:
                        await self._emit_transcript("user", self._pending_input_text)
                        self._pending_input_text = ""
                    # Accumulate response tokens when the turn completes
                    cumulative_response_text += self._current_turn_r_text
                    cumulative_response_audio += self._current_turn_r_audio
                    
                    # Reset current turn response tokens for the next turn
                    self._current_turn_r_text = 0
                    self._current_turn_r_audio = 0

                    if getattr(self, 'model_was_speaking', False):
                        self.audio_stream_event.set()
                        self.model_was_speaking = False

                    if self.all_questions_answered and self.awaiting_final_goodbye:
                        interview_done = True
                        self.awaiting_final_goodbye = False

                # Catch the tool trigger execution
                if response.tool_call:
                    for fc in response.tool_call.function_calls:
                        if fc.name == "submit_answer":
                            args = fc.args
                            q_num = int(args.get("question_number", self.current_question_idx + 1))
                            summary = args.get("user_answer_summary", "")
                            
                            print(f"\n[Saved Answer Q{q_num}]: {summary}")
                            self.full_transcript.append({"Question": PREDEFINED_QUESTIONS[self.current_question_idx], "Answer Summary": summary})

                            # Pause microphone streaming while model is processing the tool call and preparing next question
                            self.audio_stream_event.clear()

                            # Advance index
                            self.current_question_idx += 1
                            if self.current_question_idx >= len(PREDEFINED_QUESTIONS):
                                self.all_questions_answered = True

                            # Provide function output back to the model to safely trigger the next step
                            # Send an empty response to confirm answer recording; model will ask next question or close the interview
                            await session.send_tool_response(
                                function_responses=[
                                    types.FunctionResponse(
                                        name=fc.name,
                                        id=fc.id,
                                        response={"result": "Answer recorded"}
                                    )
                                ]
                            )
                            # Small pause to give the model time to generate the next question or final goodbye before we resume sending audio
                            await asyncio.sleep(0.5)

                    if interview_done:
                        break


            # print(f"\n🏁 Receive loop exited after {response_count} responses.")

            # Ensure mic_task is cancelled before cleanup
            if not mic_task.done():
                mic_task.cancel()
            try:
                await mic_task
            except (asyncio.CancelledError, OSError):
                pass

            # Allow audio buffer to finish playing final words
            await asyncio.sleep(2)
            output_stream.stop_stream()
            output_stream.close()
            self.p.terminate()

            # Notify the parent that the interview completed naturally
            await self._emit_complete()

        except Exception as e:
            print(f"\n❌ ERROR: {type(e).__name__}: {e}")
            traceback.print_exc()
            self.p.terminate()

        self.print_final_results(cumulative_prompt_text, cumulative_prompt_audio, cumulative_response_text, cumulative_response_audio)

    def print_final_results(self, p_text=0, p_audio=0, r_text=0, r_audio=0):
        summary_lines = ["CONVERSATION SUMMARY", "="*50]
        
        if not self.full_transcript:
            msg = "No answers were recorded during this session."
            print(msg)
            summary_lines.append(msg)
        else:
            for idx, item in enumerate(self.full_transcript):
                q_text = f"\nQ{idx+1}: {item['Question']}"
                a_text = f"A: {item['Answer Summary']}"
                print(q_text)
                print(a_text)
                summary_lines.extend([q_text, a_text])
            
        print("\n" + "="*50)
        print("          TOKEN USAGE REPORT")
        print("="*50)
        
        usage_lines = ["\n" + "="*50, "TOKEN USAGE REPORT", "="*50]
        
        total_p = p_text + p_audio
        total_r = r_text + r_audio
        total = total_p + total_r
        if total > 0:
            usage_text = (
                "\nFINAL SESSION USAGE:\n"
                f"- Total Input Text:      {p_text}\n"
                f"- Total Input Audio:     {p_audio}\n"
                f"- Total Output Text:     {r_text}\n"
                f"- Total Output Audio:    {r_audio}\n"
                f"- Grand Total:           {total}"
            )
            print(usage_text)
            usage_lines.append(usage_text)
        else:
            msg = "\nNo token usage metadata was received from the API."
            print(msg)
            usage_lines.append(msg)
            
        # Write to text file
        try:
            with open("interview_summary.txt", "w", encoding="utf-8") as f:
                f.write("\n".join(summary_lines + usage_lines))
            print("\n✅ Summary successfully saved to 'interview_summary.txt'")
        except Exception as e:
            print(f"\n⚠️ Failed to save summary to file: {e}")

if __name__ == "__main__":
    if not os.environ.get("GEMINI_API_KEY"):
        print("Error: Please set your GEMINI_API_KEY environment variable.")
        sys.exit(1)
        
    interview = VoiceInterviewManager()
    asyncio.run(interview.run_interview())
