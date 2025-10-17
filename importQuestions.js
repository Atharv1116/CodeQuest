// importQuestions.js
const mongoose = require('mongoose');
const fs = require('fs');

const questionSchema = new mongoose.Schema({
  title: String,
  description: String,
  inputFormat: String,
  outputFormat: String,
  sampleInput: String,
  sampleOutput: String,
  difficulty: String,
  language: String,
  solution: String
});
const Question = mongoose.model('Question', questionSchema);

(async () => {
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/codebattle', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');

    const data = JSON.parse(fs.readFileSync('./questions.json', 'utf-8'));
    if (!Array.isArray(data)) throw new Error('questions.json must be a JSON array');

    await Question.deleteMany({});           // optional: clear old questions
    const result = await Question.insertMany(data);
    console.log(`✅ Inserted ${result.length} questions`);
  } catch (err) {
    console.error('❌ Import failed:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
